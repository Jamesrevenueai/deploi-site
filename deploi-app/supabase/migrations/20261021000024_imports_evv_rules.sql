-- Phase 12 (ops): reliable CSV operations (provenance, row errors, duplicates, revisions) and EVV rule sets.

-- ---------------------------------------------------------------- EVV import provenance
alter table evv_imports
  add column if not exists file_sha256 text,
  add column if not exists row_errors jsonb not null default '[]'::jsonb,   -- [{row, field, message}]
  add column if not exists duplicates int not null default 0,
  add column if not exists skipped int not null default 0,
  add column if not exists notice text;                                      -- e.g. 'already imported'
create index if not exists evv_imports_sha_idx on evv_imports (agency_id, file_sha256) where file_sha256 is not null;

-- Generic import log for applicant / roster CSVs (same columns as evv_imports).
create table if not exists imports (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  kind text not null,                            -- applicants | aides | clients
  source text not null default 'csv',
  filename text,
  status text not null default 'committed',      -- staged | committed | discarded | already_imported
  headers jsonb not null default '[]'::jsonb,
  mapping jsonb not null default '{}'::jsonb,
  raw jsonb not null default '[]'::jsonb,
  row_count int not null default 0,
  imported int not null default 0,
  updated int not null default 0,
  skipped int not null default 0,
  duplicates int not null default 0,
  row_errors jsonb not null default '[]'::jsonb,
  file_sha256 text,
  notice text,
  created_by uuid,
  created_at timestamptz not null default now(),
  committed_at timestamptz
);
create index if not exists imports_agency_idx on imports (agency_id, kind, created_at desc);
create index if not exists imports_sha_idx on imports (agency_id, kind, file_sha256) where file_sha256 is not null;
alter table imports enable row level security;
drop policy if exists imports_tenant on imports;
create policy imports_tenant on imports for all to authenticated
  using (is_staff() or agency_id = current_agency_id()) with check (is_staff() or agency_id = current_agency_id());
drop trigger if exists audit_imports on imports;
create trigger audit_imports after insert or update or delete on imports for each row execute function audit_row();
grant all on imports to authenticated, service_role;

-- Provenance on the records themselves.
alter table visits add column if not exists import_id uuid references evv_imports(id) on delete set null;
alter table applicants add column if not exists import_id uuid references imports(id) on delete set null;

-- Original evidence and correction history survive a re-import: every change to an existing visit writes a revision first.
create table if not exists visit_revisions (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references visits(id) on delete cascade,
  agency_id uuid not null references agencies(id) on delete cascade,
  import_id uuid references evv_imports(id) on delete set null,
  previous jsonb not null,                       -- the visits row before the change
  changed_fields text[] not null default '{}',
  reviewed boolean not null default false,       -- the visit had corrected/dismissed exceptions when it was changed
  at timestamptz not null default now()
);
create index if not exists visit_revisions_visit_idx on visit_revisions (visit_id, at desc);
alter table visit_revisions enable row level security;
drop policy if exists visit_revisions_tenant on visit_revisions;
create policy visit_revisions_tenant on visit_revisions for all to authenticated
  using (is_staff() or agency_id = current_agency_id()) with check (is_staff() or agency_id = current_agency_id());
drop trigger if exists audit_visit_revisions on visit_revisions;
create trigger audit_visit_revisions after insert or update or delete on visit_revisions for each row execute function audit_row();
grant all on visit_revisions to authenticated, service_role;

-- ---------------------------------------------------------------- EVV rule sets
-- One row per (jurisdiction, program, payer, agency, effective period). No rule -> no deadline is ever computed.
create table if not exists evv_rule_sets (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references agencies(id) on delete cascade,  -- null = global
  program text,                                              -- PASSPORT | OHCW | MyCare | DODD | ... ; null = any
  payer text,                                                -- null = any
  jurisdiction text not null default 'OH',                   -- state
  effective_from date,
  effective_to date,
  correction_window_days int,                                -- nullable on purpose: unknown stays unknown
  unit_minutes int not null default 15,
  unit_rounding text not null default 'nearest' check (unit_rounding in ('nearest','down','up')),
  duration_tolerance_min int not null default 15,
  source_name text,
  source_url text,
  source_version text,
  verified boolean not null default false,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists evv_rule_sets_lookup_idx on evv_rule_sets (jurisdiction, program, agency_id, effective_from);
alter table evv_rule_sets enable row level security;
drop policy if exists evv_rule_sets_read on evv_rule_sets;
create policy evv_rule_sets_read on evv_rule_sets for select to authenticated
  using (is_staff() or agency_id is null or agency_id = current_agency_id());
drop policy if exists evv_rule_sets_staff_write on evv_rule_sets;
create policy evv_rule_sets_staff_write on evv_rule_sets for all to authenticated using (is_staff()) with check (is_staff());
drop trigger if exists audit_evv_rule_sets on evv_rule_sets;
create trigger audit_evv_rule_sets after insert or update or delete on evv_rule_sets for each row execute function audit_row();
drop trigger if exists touch_updated_evv_rule_sets on evv_rule_sets;
create trigger touch_updated_evv_rule_sets before update on evv_rule_sets for each row execute function set_updated_at();
grant all on evv_rule_sets to authenticated, service_role;

-- Which rule set produced an exception's deadline (null = deadline not configured).
alter table evv_exceptions add column if not exists rule_set_id uuid references evv_rule_sets(id) on delete set null;
