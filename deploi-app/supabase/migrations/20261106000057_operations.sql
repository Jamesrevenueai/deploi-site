-- =============================================================================
-- Operations and agent reliability:
--   1. alerts      one row per firing rule + subject (deduplicated while open), auto-resolved when the
--                  condition clears; routed to staff and, for organization alerts, the organization owner
--                  (lib/ops/alerts.ts, evaluated every 10 minutes by the durable job ops.alerts)
--   2. ops_logs    structured operational logs (jobs and cases) with correlation ids: job id, case id/ref,
--                  organization; details are redacted before they are written (lib/ops/logs.ts)
--   3. ai_assists  which path an AI-assisted step took (model or deterministic rules) for one subject (an
--                  inbound email, a draft), so a step is decided once and the same subject never pays twice
-- Same RLS model as the rest: members read their own organization's rows, staff read all, every write goes
-- through server functions (service role). Alerts without an organization (platform alerts) are staff-only.
-- Rollback: supabase/rollback/20261106000057_operations.down.sql
-- =============================================================================

-- ---------------------------------------------------------------- 1. alerts
create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  -- null: a platform alert (queue, crons), visible to staff only
  org_id uuid references agencies(id) on delete cascade,
  rule text not null check (rule ~ '^[a-z][a-z0-9_.]{1,63}$'),
  -- what the alert is about inside the rule ('all', a cron key, a case id, a connection ...)
  subject text not null check (length(subject) between 1 and 200),
  severity text not null default 'warn' check (severity in ('warn', 'page')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  title text not null check (length(title) between 1 and 300),
  detail jsonb not null default '{}'::jsonb,
  occurrences int not null default 1 check (occurrences >= 1),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  acknowledged_by text check (length(acknowledged_by) <= 160),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolved_reason text check (length(resolved_reason) <= 300),
  -- who was told, and how it went (recipients are addresses of staff and of the owner; never shown to tenants)
  notified jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- one live alert per rule and subject: a condition seen again updates it, never opens a second one
create unique index if not exists alerts_one_live on alerts (rule, subject) where status <> 'resolved';
create index if not exists alerts_org_recent on alerts (org_id, last_seen_at desc);
create index if not exists alerts_live on alerts (status, last_seen_at desc) where status <> 'resolved';

-- ---------------------------------------------------------------- 2. operational logs
create table if not exists ops_logs (
  id bigserial primary key,
  at timestamptz not null default now(),
  level text not null check (level in ('info', 'warn', 'error')),
  event text not null check (event ~ '^[a-z][a-z0-9_.:-]{1,79}$'),
  org_id uuid references agencies(id) on delete cascade,
  job_id uuid,
  case_id uuid,
  case_ref text check (length(case_ref) <= 40),
  correlation_id text check (length(correlation_id) <= 120),
  summary text check (length(summary) <= 500),
  detail jsonb not null default '{}'::jsonb
);
create index if not exists ops_logs_recent on ops_logs (at desc);
create index if not exists ops_logs_org on ops_logs (org_id, at desc);
create index if not exists ops_logs_job on ops_logs (job_id) where job_id is not null;
create index if not exists ops_logs_case on ops_logs (case_ref) where case_ref is not null;
create index if not exists ops_logs_corr on ops_logs (correlation_id) where correlation_id is not null;

-- ---------------------------------------------------------------- 3. AI-assisted steps
create table if not exists ai_assists (
  id bigserial primary key,
  org_id uuid not null references agencies(id) on delete cascade,
  case_id uuid,
  purpose text not null check (purpose ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  -- the thing decided (e.g. inbound:<uuid>, draft:<key>)
  subject_ref text not null check (length(subject_ref) between 1 and 200),
  path text not null check (path in ('ai', 'rules')),
  -- why the rules ran when the model did not (budget, timeout, invalid_output ...); null for path ai
  fallback text check (length(fallback) <= 300),
  -- the validated output (data only), or {} for the rules path
  result jsonb not null default '{}'::jsonb,
  usage_id bigint,
  created_at timestamptz not null default now(),
  unique (org_id, purpose, subject_ref)
);
create index if not exists ai_assists_case on ai_assists (case_id) where case_id is not null;

-- ---------------------------------------------------------------- RLS
do $$ declare t text; begin
  foreach t in array array['alerts', 'ops_logs', 'ai_assists'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_org_read', t);
    execute format('create policy %I on %I for select to authenticated using (is_staff() or org_id = current_org_id())', t || '_org_read', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('grant all on %I to service_role', t);
  end loop;
end $$;
-- who was notified is staff-only information
revoke select on alerts from authenticated;
grant select (id, org_id, rule, subject, severity, status, title, detail, occurrences, first_seen_at, last_seen_at, acknowledged_at, resolved_at, resolved_reason, created_at, updated_at) on alerts to authenticated;
grant usage on sequence ops_logs_id_seq, ai_assists_id_seq to service_role;
