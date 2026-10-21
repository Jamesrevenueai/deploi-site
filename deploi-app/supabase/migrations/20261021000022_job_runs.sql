-- Scheduled-job idempotency (phases 11/15): one execution per (job_key, period_key).
create table if not exists job_runs (
  id uuid primary key default gen_random_uuid(),
  job_key text not null,
  period_key text not null,
  status text not null default 'running',   -- running | done | failed
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb not null default '{}'::jsonb,
  unique (job_key, period_key)
);
alter table job_runs enable row level security;
drop policy if exists job_runs_staff on job_runs;
create policy job_runs_staff on job_runs for all to authenticated using (is_staff()) with check (is_staff());
grant all on job_runs to authenticated, service_role;
drop trigger if exists audit_job_runs on job_runs;
create trigger audit_job_runs after insert or update or delete on job_runs for each row execute function audit_row();
