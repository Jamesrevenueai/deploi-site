-- =============================================================================
-- Business Discovery: after an organization connects an app (a store, HubSpot, a calendar, a mailbox) Deploi
-- reads what it is authorized to read, runs every registered detector, opens `detected` cases for what it
-- finds (lib/cases) and recommends an AI team. Three tables:
--   discovery_runs      one row per run: trigger, status, sources read (and not read, with the reason),
--                       per-detector outcome, the cases it opened, the recommended team
--   business_profiles   the latest profile of the organization: counts and facts, each with its source and
--                       the time it was observed; built only from authorized data, never inferred
--   discovery_agents    the agents one-click setup created from a recommendation (one per template), so a
--                       repeated setup never creates a second agent
-- Same RLS model as the Resolution Engine: members read their own organization's rows, staff read all,
-- every write goes through server functions (service role).
-- Rollback: supabase/rollback/20261105000049_discovery.down.sql
-- =============================================================================
create table if not exists discovery_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references agencies(id) on delete cascade,
  -- manual: the owner asked; connection: an app was just connected; schedule: a periodic refresh; test
  trigger text not null check (trigger in ('manual', 'connection', 'schedule', 'test')),
  -- what caused it, e.g. shopify:<connection id>, hubspot:<connection id>, mailbox:<account id>
  source text check (length(source) <= 200),
  -- partial: finished, but some detector or source could not be read (recorded in detectors / sources)
  status text not null default 'running' check (status in ('running', 'completed', 'partial', 'failed')),
  status_reason text check (length(status_reason) <= 1000),
  -- [{ app, label, status: read | not_read | failed | timeout, reason, at }]
  sources jsonb not null default '[]'::jsonb,
  -- [{ key, suite, sourceApp, status: ok | not_available | failed | timeout, findings, casesOpened, casesExisting, notes, ms }]
  detectors jsonb not null default '[]'::jsonb,
  case_ids uuid[] not null default '{}',
  findings_count int not null default 0,
  cases_opened int not null default 0,
  -- the recommended team, ordered by value (findings first)
  recommendations jsonb not null default '[]'::jsonb,
  created_by text not null check (length(created_by) <= 160),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint discovery_runs_finished check ((status = 'running') = (finished_at is null))
);
-- one run at a time per organization
create unique index if not exists discovery_runs_one_running on discovery_runs (org_id) where status = 'running';
create index if not exists discovery_runs_org on discovery_runs (org_id, started_at desc);

create table if not exists business_profiles (
  org_id uuid primary key references agencies(id) on delete cascade,
  run_id uuid references discovery_runs(id) on delete set null,
  -- { platforms: [...], facts: [{ key, label, value, source, observedAt }], notRead: [{ app, reason }] }
  profile jsonb not null default '{}'::jsonb,
  built_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists discovery_agents (
  org_id uuid not null references agencies(id) on delete cascade,
  template text not null check (length(template) between 3 and 60),
  agent_kind text not null check (agent_kind in ('engine', 'office')),
  -- null while a setup request holds the claim (claimed_at); set once the agent exists
  agent_id uuid,
  claimed_at timestamptz not null default now(),
  created_by text not null check (length(created_by) <= 160),
  created_at timestamptz not null default now(),
  primary key (org_id, template)
);

do $$ declare t text; begin
  foreach t in array array['discovery_runs', 'business_profiles', 'discovery_agents'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
drop trigger if exists touch_updated_business_profiles on business_profiles;
create trigger touch_updated_business_profiles before update on business_profiles for each row execute function set_updated_at();
