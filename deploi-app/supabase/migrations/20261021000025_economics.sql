-- Phase 14: internal economics. Staff-only. Clients can never read rates, labor, costs, revenue or margins.
-- Rates are synthetic defaults; staff edit them at /staff/economics/rates. Manual entry only; no accounting system.

create table if not exists internal_rates (
  key text primary key,                       -- assessment_labor | build_labor | review_labor | support_labor | troubleshooting_labor
  label text not null,
  hourly_cents int not null check (hourly_cents >= 0),
  effective_from date not null default current_date,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table internal_rates enable row level security;
drop policy if exists internal_rates_staff_all on internal_rates;
create policy internal_rates_staff_all on internal_rates for all to authenticated using (is_staff()) with check (is_staff());
grant all on internal_rates to authenticated, service_role;

-- text primary key: dedicated audit trigger (audit_row() keys on new.id)
create or replace function audit_internal_rates_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_events (actor_id, agency_id, table_name, row_id, action, ip)
  values (auth.uid(), null, 'internal_rates', coalesce(new.key, old.key), lower(tg_op), nullif(current_setting('app.ip', true), ''));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists audit_internal_rates on internal_rates;
create trigger audit_internal_rates after insert or update or delete on internal_rates for each row execute function audit_internal_rates_row();

-- synthetic defaults ($85/h); never overwritten once edited
insert into internal_rates (key, label, hourly_cents) values
  ('assessment_labor', 'Assessment labor', 8500),
  ('build_labor', 'Build labor', 8500),
  ('review_labor', 'Review labor', 8500),
  ('support_labor', 'Support labor', 8500),
  ('troubleshooting_labor', 'Troubleshooting labor', 8500)
on conflict (key) do nothing;

create table if not exists labor_entries (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references agencies(id) on delete set null,
  ref_type text not null default 'general' check (ref_type in ('assessment','engagement','website','agency','general')),
  ref_id text,
  kind text not null check (kind in ('assessment','build','review','support','troubleshooting')),
  hours numeric(6,2) not null check (hours >= 0),
  note text,
  logged_by uuid,
  logged_on date not null default current_date,
  created_at timestamptz not null default now()
);
create index if not exists labor_entries_agency_idx on labor_entries (agency_id, logged_on desc);

create table if not exists cost_entries (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references agencies(id) on delete set null,
  ref_type text not null default 'general' check (ref_type in ('assessment','engagement','website','agency','general')),
  ref_id text,
  kind text not null check (kind in ('hosting','model_usage','third_party','credit','refund')),
  amount_cents int not null,                   -- credits and refunds are negative
  note text,
  incurred_on date not null default current_date,
  logged_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists cost_entries_agency_idx on cost_entries (agency_id, incurred_on desc);

create table if not exists revenue_entries (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  ref_type text not null default 'agency' check (ref_type in ('assessment','engagement','website','agency','general')),
  ref_id text,
  kind text not null check (kind in ('assessment_fee','setup_fee','monthly_fee','website_fee','other')),
  amount_cents int not null,
  status text not null default 'projected' check (status in ('projected','invoiced','collected','mock')),
  is_mock boolean not null default false,      -- mock payments are never counted as collected
  collected_on date,
  note text,
  logged_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists revenue_entries_agency_idx on revenue_entries (agency_id, status);

do $$
declare t text;
begin
  foreach t in array array['labor_entries','cost_entries','revenue_entries'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_staff_all', t);
    execute format('create policy %I on %I for all to authenticated using (is_staff()) with check (is_staff())', t || '_staff_all', t);
    execute format('grant all on %I to authenticated, service_role', t);
    execute format('drop trigger if exists %I on %I', 'audit_' || t, t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row()', 'audit_' || t, t);
  end loop;
end $$;
