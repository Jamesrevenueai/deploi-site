-- Phase 13: pilot definition, measurements (baseline vs pilot) and the pilot decision.
create table if not exists pilots (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  agency_id uuid not null references agencies(id) on delete cascade,
  starts_on date,
  ends_on date,
  primary_workflow text not null,                      -- service_key
  scope text,
  sample_description text,
  baseline_start date,
  baseline_end date,
  primary_metric_key text,                             -- one of the service's successMeasures keys
  quality_guardrails jsonb not null default '[]'::jsonb,
  data_sources jsonb not null default '[]'::jsonb,
  review_owner text,
  decision_date date,
  decision text check (decision is null or decision in ('continue','revise','expand','pause','stop')),
  decision_note text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (engagement_id)
);

create table if not exists pilot_measurements (
  id uuid primary key default gen_random_uuid(),
  pilot_id uuid not null references pilots(id) on delete cascade,
  agency_id uuid not null references agencies(id) on delete cascade,
  metric_key text not null,
  period text not null check (period in ('baseline','pilot')),
  period_start date not null,
  period_end date not null,
  numerator numeric,
  denominator numeric,
  value numeric,
  sample_size int,
  missing_data_note text,
  source text not null default 'computed',             -- computed | manual
  computed_at timestamptz not null default now(),
  computed_by uuid,
  unique (pilot_id, metric_key, period)
);
create index if not exists pilot_measurements_pilot_idx on pilot_measurements (pilot_id, period);

alter table pilots enable row level security;
alter table pilot_measurements enable row level security;
drop policy if exists pilots_tenant on pilots;
create policy pilots_tenant on pilots for all to authenticated
  using (is_staff() or agency_id = current_agency_id()) with check (is_staff());
drop policy if exists pilot_measurements_tenant on pilot_measurements;
create policy pilot_measurements_tenant on pilot_measurements for all to authenticated
  using (is_staff() or agency_id = current_agency_id()) with check (is_staff());
grant all on pilots, pilot_measurements to authenticated, service_role;

drop trigger if exists audit_pilots on pilots;
create trigger audit_pilots after insert or update or delete on pilots for each row execute function audit_row();
drop trigger if exists audit_pilot_measurements on pilot_measurements;
create trigger audit_pilot_measurements after insert or update or delete on pilot_measurements for each row execute function audit_row();
drop trigger if exists touch_updated_pilots on pilots;
create trigger touch_updated_pilots before update on pilots for each row execute function set_updated_at();
