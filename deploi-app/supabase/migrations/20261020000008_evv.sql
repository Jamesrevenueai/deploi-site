-- Section 8: EVV exception layer. Import history + staging for the two-step CSV import.
create table if not exists evv_imports (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  source text not null default 'generic',       -- sandata | generic
  filename text,
  status text not null default 'staged',        -- staged | committed | discarded
  headers jsonb not null default '[]'::jsonb,
  mapping jsonb not null default '{}'::jsonb,   -- {field: header}
  raw jsonb not null default '[]'::jsonb,       -- parsed rows (header -> value); discarded after commit
  row_count int not null default 0,
  imported int not null default 0,
  updated int not null default 0,
  exceptions_opened int not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  committed_at timestamptz
);
create index if not exists evv_imports_agency_idx on evv_imports (agency_id, created_at desc);
alter table evv_imports enable row level security;
drop policy if exists evv_imports_tenant on evv_imports;
create policy evv_imports_tenant on evv_imports for all to authenticated
  using (is_staff() or agency_id = current_agency_id()) with check (is_staff() or agency_id = current_agency_id());
drop trigger if exists audit_evv_imports on evv_imports;
create trigger audit_evv_imports after insert or update or delete on evv_imports for each row execute function audit_row();
grant all on evv_imports to authenticated, service_role;
