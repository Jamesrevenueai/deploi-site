-- =============================================================================
-- Legal acceptance tracking, Stripe/Shopify subscription state, and security hardening from the
-- 2026-11-04 review (docs/SECURITY-REVIEW-2026-11-04.md).
--
--  legal_documents     registry of each legal document version the app has served (key, version, sha256).
--                      Rows are written by the server as 'draft'. Nothing in the app marks a row published:
--                      publishing is a deliberate, manual step after counsel review.
--  legal_acceptances   append-only clickwrap evidence: who accepted which exact text, when, from where.
--                      No update ever (trigger); no direct delete (trigger), only the cascade from an
--                      organization being deleted.
--  billing_customers   one Stripe customer per organization (reused across checkouts).
--  billing_subscriptions  the organization's subscription per provider (stripe | shopify).
--  billing_events      Stripe webhook events by id: dedupe and an audit of what was processed.
--
-- Same RLS model as the engine: members read their own organization's rows, staff read all, every write
-- goes through server-side functions under the service role.
-- Rollback: supabase/rollback/20261104000042_legal_billing.down.sql
-- =============================================================================

-- ---------------------------------------------------------------- legal documents
create table if not exists legal_documents (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  version text not null check (length(version) between 1 and 40),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  title text not null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  first_seen_at timestamptz not null default now(),
  unique (key, version, sha256),
  check ((status = 'published') = (published_at is not null))
);
alter table legal_documents enable row level security;
drop policy if exists legal_documents_read on legal_documents;
-- the registry holds document metadata only (no organization data): every signed-in user may read it
create policy legal_documents_read on legal_documents for select to authenticated using (true);
revoke all on legal_documents from anon, authenticated;
grant select on legal_documents to authenticated;
grant all on legal_documents to service_role;
drop trigger if exists audit_legal_documents on legal_documents;
create trigger audit_legal_documents after insert or update or delete on legal_documents for each row execute function audit_row();

-- ---------------------------------------------------------------- legal acceptances (append-only)
create table if not exists legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  -- the person who clicked: a profile id, or shopify:<shop>:<user id> for an embedded Shopify admin user
  user_id text not null check (length(user_id) between 1 and 200),
  user_email text,
  document_key text not null,
  document_version text not null,
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  -- status of the text at the moment it was accepted: 'draft' acceptances are pilot acceptances of an unreviewed draft
  document_status text not null check (document_status in ('draft', 'published')),
  product text check (product in ('commerce', 'office')),
  method text not null default 'clickwrap' check (method in ('clickwrap')),
  accepted_at timestamptz not null default now(),
  ip text,
  user_agent text check (user_agent is null or length(user_agent) <= 512)
);
create index if not exists legal_acceptances_org on legal_acceptances (org_id, document_key, accepted_at desc);
alter table legal_acceptances enable row level security;
drop policy if exists legal_acceptances_org_read on legal_acceptances;
create policy legal_acceptances_org_read on legal_acceptances for select to authenticated using (is_staff() or org_id = current_org_id());
revoke all on legal_acceptances from anon, authenticated;
grant select on legal_acceptances to authenticated;
grant all on legal_acceptances to service_role;

create or replace function legal_acceptances_append_only() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'TRUNCATE') then
    raise exception 'legal_acceptances is append-only: an acceptance can never be changed or truncated';
  end if;
  -- a delete is allowed only as the cascade from deleting the organization (depth > 1: fired from the FK action)
  if tg_op = 'DELETE' and pg_trigger_depth() < 2 then
    raise exception 'legal_acceptances is append-only: an acceptance can only be removed with its organization';
  end if;
  return old;
end $$;
drop trigger if exists legal_acceptances_no_change on legal_acceptances;
create trigger legal_acceptances_no_change before update or delete on legal_acceptances for each row execute function legal_acceptances_append_only();
drop trigger if exists legal_acceptances_no_truncate on legal_acceptances;
create trigger legal_acceptances_no_truncate before truncate on legal_acceptances for each statement execute function legal_acceptances_append_only();
drop trigger if exists audit_legal_acceptances on legal_acceptances;
create trigger audit_legal_acceptances after insert on legal_acceptances for each row execute function audit_row();

-- ---------------------------------------------------------------- billing
create table if not exists billing_customers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references agencies(id) on delete cascade,
  provider text not null default 'stripe' check (provider in ('stripe')),
  external_id text not null unique,
  livemode boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists billing_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  provider text not null check (provider in ('stripe', 'shopify')),
  external_id text,
  customer_external_id text,
  status text not null check (status in ('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused')),
  plan text check (plan in ('starter', 'growth', 'pro')),
  interval text not null default 'month' check (interval in ('month')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  trial_end timestamptz,
  past_due_since timestamptz,
  livemode boolean not null default false,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider)
);
create unique index if not exists billing_subscriptions_external on billing_subscriptions (provider, external_id) where external_id is not null;

create table if not exists billing_events (
  id text primary key,                      -- Stripe event id (evt_...)
  provider text not null default 'stripe' check (provider in ('stripe')),
  type text not null,
  org_id uuid references agencies(id) on delete set null,
  livemode boolean not null default false,
  outcome text not null default 'received' check (outcome in ('received', 'processed', 'ignored', 'failed')),
  detail text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

do $$
declare t text;
begin
  foreach t in array array['billing_customers','billing_subscriptions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
    execute format('drop trigger if exists %I on %I', 'audit_' || t, t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row()', 'audit_' || t, t);
    execute format('drop trigger if exists %I on %I', 'touch_updated_' || t, t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'touch_updated_' || t, t);
  end loop;
end $$;
-- webhook events: staff only (raw provider data, not shown to merchants)
alter table billing_events enable row level security;
drop policy if exists billing_events_staff on billing_events;
create policy billing_events_staff on billing_events for select to authenticated using (is_staff());
revoke all on billing_events from anon, authenticated;
grant select on billing_events to authenticated;
grant all on billing_events to service_role;

-- =============================================================================
-- Security hardening (SECURITY-REVIEW-2026-11-04 findings F-01 .. F-05)
-- =============================================================================

-- F-01: the `leads` view ran with its owner's rights, so any signed-in user (or anyone with a Supabase
-- session) could read every early-access application through it, bypassing RLS on prospects.
-- It is not used by application code. Run it with the caller's rights and close it to user roles.
alter view if exists leads set (security_invoker = true);
revoke all on leads from anon, authenticated;

-- F-02: new users chose their own role and organization. handle_new_user trusted raw_user_meta_data,
-- which the person signing up controls (Supabase signUp / signInWithOtp `data`), and matched staff
-- e-mail by substring (hello@getdeploi.co matched hello@getdeploi.com). Only server-set app metadata
-- and invites may now assign an organization or role, and staff is an exact e-mail match.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role user_role := 'client';
  v_agency uuid := null;
  -- raw_app_meta_data is writable only with the service role key; raw_user_meta_data is not trusted
  v_meta jsonb := coalesce(to_jsonb(new) -> 'raw_app_meta_data', '{}'::jsonb);
  v_invite invites%rowtype;
begin
  if nullif(v_meta ->> 'agency_id', '') is not null then
    begin v_agency := (v_meta ->> 'agency_id')::uuid; exception when others then v_agency := null; end;
  end if;
  if (v_meta ->> 'role') in ('staff', 'client') then
    v_role := (v_meta ->> 'role')::user_role;
  end if;
  if v_agency is null then
    select * into v_invite from invites where lower(email) = lower(new.email) and accepted_at is null and status <> 'revoked'
      order by invited_at desc limit 1;
    if found then v_agency := v_invite.agency_id; v_role := v_invite.role; end if;
  end if;
  if lower(new.email) = any (select btrim(x) from unnest(string_to_array(staff_email_list(), ',')) as x where btrim(x) <> '') then
    v_role := 'staff';
  end if;
  insert into profiles (id, email, role, agency_id) values (new.id, new.email, v_role, v_agency)
  on conflict (id) do nothing;
  update invites set accepted_at = now(), status = 'accepted', supabase_user_id = new.id
    where lower(email) = lower(new.email) and accepted_at is null and status <> 'revoked';
  return new;
end $$;

-- F-03: the staff e-mail list was callable by anyone (anon RPC). Only the definer trigger above needs it.
revoke execute on function staff_email_list() from public, anon, authenticated;

-- F-04: TRUNCATE (and TRIGGER/REFERENCES) were granted to anon and authenticated on many tables through
-- default privileges. TRUNCATE is not subject to row-level security. No user session needs any of them.
do $$
declare t text;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') loop
    execute format('revoke truncate, trigger, references on %I from anon, authenticated', t);
  end loop;
end $$;
alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated;

-- F-05: the migration ledger had no RLS and was writable by user roles.
do $$ begin
  if to_regclass('public._migrations') is not null then
    execute 'alter table _migrations enable row level security';
    execute 'revoke all on _migrations from anon, authenticated';
  end if;
end $$;

-- org_products was writable by anon through default privileges (RLS had no anon policy, so it was
-- refused, but the grant should not exist); match the intended select-only grant.
revoke insert, update, delete on org_products from anon, authenticated;
revoke all on org_products from anon;
