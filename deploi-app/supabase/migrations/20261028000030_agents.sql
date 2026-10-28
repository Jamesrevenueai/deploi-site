-- =============================================================================
-- Named agents with versioned standing authorizations, merchant reference files, agent runs.
-- Same RLS model as the engine: organization members read their own rows; every write goes
-- through server-side functions (service role) after an explicit authorization check.
-- =============================================================================

alter table store_connections add column if not exists currency text;

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  connection_id uuid not null references store_connections(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  task_text text not null default '',
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'revoked', 'deleted')),
  active_policy_id uuid,
  schedule jsonb not null default '{"kind":"manual"}'::jsonb,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agents_org_idx on agents (org_id, status);
create index if not exists agents_due_idx on agents (next_run_at) where status = 'active';

-- One row per version of an agent's structured task + permission policy. Only a granted version
-- can be active; the policy_hash is what the merchant granted.
create table if not exists agent_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  version int not null,
  policy jsonb not null,
  policy_hash text not null,
  summary jsonb not null default '[]'::jsonb,
  status text not null default 'pending_grant' check (status in ('pending_grant', 'active', 'superseded', 'revoked', 'discarded')),
  requires_grant boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  granted_by text,
  granted_at timestamptz,
  revoked_by text,
  revoked_at timestamptz,
  revoke_reason text,
  unique (agent_id, version)
);
create unique index if not exists agent_policies_one_active on agent_policies (agent_id) where status = 'active';
alter table agents drop constraint if exists agents_active_policy_fk;
alter table agents add constraint agents_active_policy_fk foreign key (active_policy_id) references agent_policies(id) on delete set null;

create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  policy_id uuid references agent_policies(id) on delete set null,
  policy_version int,
  trigger text not null check (trigger in ('manual', 'schedule', 'webhook', 'test')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'blocked')),
  status_reason text,
  scan_id uuid references scans(id) on delete set null,
  counts jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists agent_runs_agent_idx on agent_runs (agent_id, started_at desc);

-- Merchant reference files (price lists, SKU mappings, publication lists). Stored as data only.
create table if not exists reference_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  connection_id uuid not null references store_connections(id) on delete cascade,
  kind text not null check (kind in ('price_list', 'sku_mapping', 'publication_list')),
  name text not null,
  version int not null default 1,
  status text not null default 'active' check (status in ('active', 'archived')),
  row_count int not null default 0,
  error_count int not null default 0,
  ambiguous_keys int not null default 0,
  file_sha256 text,
  columns jsonb not null default '[]'::jsonb,
  row_errors jsonb not null default '[]'::jsonb,
  uploaded_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reference_sources_conn_idx on reference_sources (connection_id, kind);

create table if not exists reference_rows (
  id bigserial primary key,
  source_id uuid not null references reference_sources(id) on delete cascade,
  org_id uuid not null references agencies(id) on delete cascade,
  version int not null,
  row_number int not null,
  match_key text not null,
  data jsonb not null,
  unique (source_id, version, row_number)
);
create index if not exists reference_rows_lookup on reference_rows (source_id, version, match_key);

-- Engine links: which agent, policy version and reference version produced each record.
alter table scans add column if not exists agent_id uuid references agents(id) on delete set null;
alter table issues add column if not exists agent_id uuid references agents(id) on delete set null;
alter table proposals add column if not exists agent_id uuid references agents(id) on delete set null;
alter table proposals add column if not exists policy_id uuid references agent_policies(id) on delete set null;
alter table proposals add column if not exists policy_version int;
alter table executions add column if not exists agent_id uuid references agents(id) on delete set null;
alter table executions add column if not exists policy_id uuid references agent_policies(id) on delete set null;
alter table executions add column if not exists policy_version int;
alter table executions add column if not exists before_value jsonb;
alter table executions add column if not exists after_value jsonb;
alter table executions add column if not exists qualification jsonb;

alter table approvals add column if not exists policy_id uuid references agent_policies(id) on delete set null;
alter table approvals add column if not exists policy_version int;
alter table approvals add column if not exists qualification jsonb;
alter table approvals drop constraint if exists approvals_approver_kind_check;
alter table approvals add constraint approvals_approver_kind_check check (approver_kind in ('profile', 'shopify_user', 'standing_authorization'));

alter table executions drop constraint if exists executions_status_check;
alter table executions add constraint executions_status_check check (status in (
  'queued', 'prechecking', 'blocked', 'stale', 'executing', 'applied', 'unknown', 'verified', 'failed', 'verification_failed'));

-- Live issues are unique per connection, agent and fingerprint (agents may watch the same record for different reasons).
drop index if exists issues_live_fingerprint;
create unique index if not exists issues_live_fingerprint on issues (connection_id, coalesce(agent_id, '00000000-0000-0000-0000-000000000000'::uuid), fingerprint)
  where status in ('open', 'needs_review');
create index if not exists proposals_agent_idx on proposals (agent_id, status);
create index if not exists executions_agent_day_idx on executions (agent_id, started_at);

-- ---------------------------------------------------------------- RLS
do $$
declare t text;
begin
  foreach t in array array['agents','agent_policies','agent_runs','reference_sources','reference_rows'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
  foreach t in array array['agents','agent_policies','agent_runs','reference_sources'] loop
    execute format('drop trigger if exists %I on %I', 'audit_' || t, t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row()', 'audit_' || t, t);
  end loop;
  foreach t in array array['agents','reference_sources'] loop
    execute format('drop trigger if exists %I on %I', 'touch_updated_' || t, t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'touch_updated_' || t, t);
  end loop;
end $$;
grant usage on sequence reference_rows_id_seq to service_role;
