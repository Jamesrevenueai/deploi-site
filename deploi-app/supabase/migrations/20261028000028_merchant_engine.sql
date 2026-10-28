-- =============================================================================
-- Merchant product: shared issue / proposal / approval / execution / verification engine.
-- The existing agencies table is the tenant (organization) row for every customer; merchant
-- organizations carry org_type = 'merchant'. Isolation reuses the same RLS model.
-- Authenticated users get SELECT on engine tables for their own organization only; every state
-- change runs through server-side engine functions (service role) after an explicit
-- authorization check. Credentials are never readable by authenticated users.
-- =============================================================================

alter table agencies add column if not exists org_type text not null default 'care_agency';
alter table agencies drop constraint if exists agencies_org_type_chk;
alter table agencies add constraint agencies_org_type_chk check (org_type in ('care_agency', 'merchant'));

-- The organization the caller acts for: a signed-in profile's organization, or (embedded Shopify
-- sessions verified by the server) the org_id the server put in the request claims. Clients never
-- mint these claims: the app only reaches Postgres from the server.
create or replace function current_org_id() returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select agency_id from profiles where id = auth.uid()),
    nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'org_id', '')::uuid)
$$;
grant execute on function current_org_id() to authenticated, service_role;

-- ---------------------------------------------------------------- connections + credentials
create table if not exists store_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  platform text not null check (platform in ('shopify', 'woocommerce', 'amazon')),
  external_id text not null,            -- shopify: <shop>.myshopify.com; woocommerce: site URL; amazon: <sellerId>:<marketplaceId>
  display_name text,
  status text not null default 'pending' check (status in ('pending', 'active', 'uninstalled', 'error', 'disconnected')),
  scopes text[] not null default '{}',
  api_version text,
  is_synthetic boolean not null default false,   -- bound to the local synthetic store; never a real merchant
  timezone text,
  installed_at timestamptz,
  uninstalled_at timestamptz,
  last_scan_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, external_id)
);
create index if not exists store_connections_org_idx on store_connections (org_id);

-- Encrypted at rest by the application (AES-256-GCM, key outside the database, row id as AAD).
create table if not exists store_credentials (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null unique references store_connections(id) on delete cascade,
  org_id uuid not null references agencies(id) on delete cascade,
  token_kind text not null default 'offline' check (token_kind in ('offline', 'online', 'api_key_pair', 'lwa_refresh')),
  key_id text not null,
  ciphertext text not null,
  refresh_ciphertext text,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  refresh_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- merchant rules
create table if not exists merchant_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  connection_id uuid not null references store_connections(id) on delete cascade,
  check_key text not null,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  version int not null default 1,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, check_key)
);
create or replace function bump_rule_version() returns trigger language plpgsql as $$
begin
  if new.config is distinct from old.config or new.enabled is distinct from old.enabled then
    new.version := old.version + 1;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists merchant_rules_version on merchant_rules;
create trigger merchant_rules_version before update on merchant_rules for each row execute function bump_rule_version();

-- ---------------------------------------------------------------- scans
create table if not exists scans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  connection_id uuid not null references store_connections(id) on delete cascade,
  trigger text not null check (trigger in ('manual', 'install', 'webhook', 'schedule', 'demo', 'test')),
  scope text not null default 'full' check (scope in ('full', 'targeted')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  resources_scanned int not null default 0,
  issues_opened int not null default 0,
  issues_updated int not null default 0,
  issues_resolved int not null default 0,
  proposals_created int not null default 0,
  proposals_invalidated int not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists scans_connection_idx on scans (connection_id, started_at desc);

-- ---------------------------------------------------------------- issues
create table if not exists issues (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  connection_id uuid not null references store_connections(id) on delete cascade,
  platform text not null,
  check_key text not null,
  kind text not null check (kind in ('correctable', 'needs_person')),
  resource_type text not null,
  resource_id text not null,
  resource_label text,
  fingerprint text not null,
  severity text not null check (severity in ('high', 'medium', 'low')),
  status text not null default 'open' check (status in ('open', 'needs_review', 'resolved', 'dismissed')),
  status_reason text,
  evidence jsonb not null,
  rule_version int,
  first_detected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_scan_id uuid references scans(id) on delete set null,
  resolved_at timestamptz,
  resolution text check (resolution in ('verified_fix', 'no_longer_detected', 'dismissed_by_merchant', 'connection_removed')),
  guard_cleared_at timestamptz,   -- merchant confirmed a re-proposal after a revert (loop guard)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists issues_live_fingerprint on issues (connection_id, fingerprint) where status in ('open', 'needs_review');
create index if not exists issues_org_status_idx on issues (org_id, status, severity);

-- ---------------------------------------------------------------- proposals
create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  connection_id uuid not null references store_connections(id) on delete cascade,
  issue_id uuid not null references issues(id) on delete cascade,
  platform text not null,
  action_key text not null,
  target_type text not null,
  target_id text not null,
  target_label text,
  change jsonb not null,          -- { field, from, to }
  preconditions jsonb not null,   -- [{ path, equals, description }]
  rule_version int,
  change_hash text not null,
  status text not null default 'pending_approval' check (status in (
    'pending_approval', 'approved', 'executing', 'applied', 'verified',
    'failed', 'blocked', 'stale', 'expired', 'dismissed', 'superseded')),
  status_reason text,
  expires_at timestamptz not null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- At most one live proposal per target and action: duplicates are impossible at the database level.
create unique index if not exists proposals_live_target on proposals (connection_id, action_key, target_id)
  where status in ('pending_approval', 'approved', 'executing', 'applied');
create index if not exists proposals_org_status_idx on proposals (org_id, status);

create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  proposal_id uuid not null references proposals(id) on delete cascade,
  change_hash text not null,
  approved_by text not null,
  approver_kind text not null check (approver_kind in ('profile', 'shopify_user')),
  approved_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text
);
create unique index if not exists approvals_one_active on approvals (proposal_id) where revoked_at is null;

create table if not exists executions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  connection_id uuid not null references store_connections(id) on delete cascade,
  proposal_id uuid not null references proposals(id) on delete cascade,
  approval_id uuid not null references approvals(id) on delete cascade,
  idempotency_key text not null unique,   -- the approval id: one approval is consumed by at most one execution
  status text not null check (status in (
    'prechecking', 'blocked', 'stale', 'executing', 'applied', 'unknown', 'verified', 'failed', 'verification_failed')),
  status_reason text,
  attempt int not null default 1,
  precheck jsonb,
  request jsonb,
  response jsonb,
  verification jsonb,
  is_synthetic boolean not null default false,
  started_at timestamptz not null default now(),
  applied_at timestamptz,
  verified_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists executions_target_idx on executions (connection_id, proposal_id);

-- ---------------------------------------------------------------- audit trail (append-only)
create table if not exists engine_audit (
  id bigserial primary key,
  org_id uuid references agencies(id) on delete cascade,
  connection_id uuid,
  entity_type text not null,
  entity_id text,
  event text not null,
  actor text not null,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists engine_audit_org_idx on engine_audit (org_id, at desc);

-- ---------------------------------------------------------------- webhooks + billing
create table if not exists webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  delivery_id text not null,
  topic text not null,
  connection_id uuid references store_connections(id) on delete set null,
  status text not null default 'accepted' check (status in ('accepted', 'processed', 'ignored', 'failed')),
  note text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (platform, delivery_id)
);

create table if not exists app_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  connection_id uuid not null references store_connections(id) on delete cascade,
  provider text not null check (provider in ('shopify_billing', 'early_access')),
  plan_key text not null,
  status text not null check (status in ('pending', 'active', 'declined', 'expired', 'frozen', 'cancelled')),
  external_id text,
  is_test boolean not null default false,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists app_subscriptions_external on app_subscriptions (provider, external_id) where external_id is not null;

-- ---------------------------------------------------------------- synthetic store (demos and tests only)
create table if not exists synthetic_store_state (
  connection_id uuid primary key references store_connections(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS
do $$
declare t text;
begin
  foreach t in array array['store_connections','merchant_rules','scans','issues','proposals','approvals','executions','app_subscriptions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;

-- credentials: no policy for authenticated at all, no grant: unreadable from any user session.
alter table store_credentials enable row level security;
revoke all on store_credentials from anon, authenticated;
grant all on store_credentials to service_role;

-- audit: org members read their own trail; nobody updates or deletes it.
alter table engine_audit enable row level security;
drop policy if exists engine_audit_org_read on engine_audit;
create policy engine_audit_org_read on engine_audit for select to authenticated using (is_staff() or org_id = current_org_id());
revoke all on engine_audit from anon, authenticated, service_role;
grant select on engine_audit to authenticated;
grant select, insert on engine_audit to service_role;
grant usage on sequence engine_audit_id_seq to service_role;

-- staff-only operational tables
do $$
declare t text;
begin
  foreach t in array array['webhook_receipts','synthetic_store_state'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_staff', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff())', t || '_staff', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;

-- generic row audit on every engine table except the append-only trail itself
do $$
declare t text;
begin
  foreach t in array array['store_connections','store_credentials','merchant_rules','scans','issues','proposals','approvals','executions','webhook_receipts','app_subscriptions'] loop
    execute format('drop trigger if exists %I on %I', 'audit_' || t, t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row()', 'audit_' || t, t);
  end loop;
  foreach t in array array['store_connections','issues','proposals','executions','app_subscriptions','store_credentials'] loop
    execute format('drop trigger if exists %I on %I', 'touch_updated_' || t, t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'touch_updated_' || t, t);
  end loop;
end $$;

-- audit_row(): record the tenant for tables keyed by org_id as well as agency_id.
create or replace function audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row_id text;
  v_agency uuid;
  v_json jsonb;
begin
  if tg_op = 'DELETE' then v_json := to_jsonb(old); else v_json := to_jsonb(new); end if;
  v_row_id := v_json ->> 'id';
  begin
    v_agency := coalesce(v_json ->> 'agency_id', v_json ->> 'org_id')::uuid;
  exception when others then v_agency := null; end;
  insert into audit_events (actor_id, agency_id, table_name, row_id, action, ip)
  values (auth.uid(), v_agency, tg_table_name, v_row_id, lower(tg_op),
          nullif(current_setting('app.ip', true), ''));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
