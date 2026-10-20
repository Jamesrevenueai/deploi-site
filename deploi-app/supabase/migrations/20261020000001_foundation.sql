-- =============================================================================
-- Deploi foundation: tenancy, roles, audit, and every domain table.
-- HIPAA posture: RLS on every table; audit trigger on every write; reads of
-- client-side data are audited by the data layer (lib/db.ts) because Postgres
-- cannot trigger on SELECT.
-- =============================================================================
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enums
do $$ begin
  create type user_role as enum ('staff', 'client');
exception when duplicate_object then null; end $$;

do $$ begin
  create type prospect_stage as enum (
    'new','contacted','replied','call_booked','call_held',
    'assessment_sold','build_sold','retainer','lost');
exception when duplicate_object then null; end $$;

do $$ begin
  create type touch_channel as enum ('email','call','linkedin','referral','chat','sms','site');
exception when duplicate_object then null; end $$;

do $$ begin
  create type touch_direction as enum ('inbound','outbound');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- tenancy
create table if not exists agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text,
  county text,
  state text not null default 'OH',
  timezone text not null default 'America/New_York',
  -- {counties:[], services:[], hours:{start:'07:00',end:'19:00'}}
  capacity_rules jsonb not null default '{}'::jsonb,
  radius_miles int not null default 25,
  -- [{weekday:2, time:'10:00'}, ...] interview slots offered to applicants
  interview_slots jsonb not null default '[]'::jsonb,
  -- per-worker auto-send toggles, default OFF for everything
  auto_send jsonb not null default '{}'::jsonb,
  assessment_credit_cents int not null default 0,
  assessment_credit_expires_at timestamptz,
  prospect_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  role user_role not null default 'client',
  agency_id uuid references agencies(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- audit
create table if not exists audit_events (
  id bigserial primary key,
  actor_id uuid,
  agency_id uuid,
  table_name text not null,
  row_id text,
  action text not null, -- insert | update | delete | read
  at timestamptz not null default now(),
  ip text
);
create index if not exists audit_events_at_idx on audit_events (at desc);
create index if not exists audit_events_agency_idx on audit_events (agency_id, at desc);

-- ---------------------------------------------------------------- helpers
create or replace function current_user_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;

create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'staff' from profiles where id = auth.uid()), false)
$$;

create or replace function current_agency_id() returns uuid
language sql stable security definer set search_path = public as $$
  select agency_id from profiles where id = auth.uid()
$$;

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- Writes an audit row for every insert/update/delete. SECURITY DEFINER so a
-- client user's write is logged even though clients cannot insert audit rows.
create or replace function audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row_id text;
  v_agency uuid;
begin
  if tg_op = 'DELETE' then
    v_row_id := old.id::text;
  else
    v_row_id := new.id::text;
  end if;
  begin
    if tg_op = 'DELETE' then
      v_agency := (to_jsonb(old) ->> 'agency_id')::uuid;
    else
      v_agency := (to_jsonb(new) ->> 'agency_id')::uuid;
    end if;
  exception when others then v_agency := null; end;
  insert into audit_events (actor_id, agency_id, table_name, row_id, action, ip)
  values (auth.uid(), v_agency, tg_table_name, v_row_id, lower(tg_op),
          nullif(current_setting('app.ip', true), ''));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- Called by the data layer for reads of client-side data.
create or replace function audit_read(p_table text, p_agency uuid, p_row_ids text[])
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into audit_events (actor_id, agency_id, table_name, row_id, action, ip)
  select auth.uid(), p_agency, p_table, r, 'read', nullif(current_setting('app.ip', true), '')
  from unnest(coalesce(p_row_ids, array[]::text[])) as r;
  if p_row_ids is null or array_length(p_row_ids, 1) is null then
    insert into audit_events (actor_id, agency_id, table_name, row_id, action, ip)
    values (auth.uid(), p_agency, p_table, null, 'read', nullif(current_setting('app.ip', true), ''));
  end if;
end $$;

-- ---------------------------------------------------------------- sales (section 4)
create table if not exists prospects (
  id uuid primary key default gen_random_uuid(),
  agency_name text not null,
  owner_name text,
  email text,
  phone text,
  city text,
  county text,
  state text default 'OH',
  programs text[] not null default '{}', -- PASSPORT | OHCW | MyCare | DODD | private-pay
  source text not null default 'manual',  -- csv | smartlead | site | evv-page | chat | manual | referral
  stage prospect_stage not null default 'new',
  owner_notes text,
  email_invalid boolean not null default false,
  biggest_leak text,
  next_step text,
  follow_up_at date,
  agency_id uuid references agencies(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists prospects_email_agency_uq
  on prospects (lower(email), lower(agency_name)) where email is not null;
create index if not exists prospects_stage_idx on prospects (stage);

create table if not exists touches (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id) on delete cascade,
  channel touch_channel not null,
  direction touch_direction not null default 'outbound',
  subject text,
  body text,
  at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb
);
create index if not exists touches_prospect_idx on touches (prospect_id, at desc);

create or replace view leads as
  select * from prospects where source in ('site', 'evv-page', 'chat');

-- ---------------------------------------------------------------- assessments (section 5)
create table if not exists assessments (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid references prospects(id) on delete set null,
  agency_id uuid not null references agencies(id) on delete cascade,
  status text not null default 'draft', -- draft | in_progress | complete
  inputs jsonb not null default '{}'::jsonb,
  leaks jsonb not null default '[]'::jsonb,
  recommended_door text,
  report_path text,
  report_generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists trace_steps (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references assessments(id) on delete cascade,
  agency_id uuid not null references agencies(id) on delete cascade,
  trace text not null,            -- referral | visit
  step_key text not null,
  step_order int not null,
  occurred_at timestamptz,
  who text,
  what_went_wrong text,
  outcome text,
  note text,
  created_at timestamptz not null default now(),
  unique (assessment_id, trace, step_key)
);

-- ---------------------------------------------------------------- client ops (sections 6-8)
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  program text,
  county text,
  service_codes text[] not null default '{}',
  lat double precision,
  lng double precision,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists aides (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  phone text,
  email text,
  -- [{type:'STNA'|'CPR'|'TB'|'BCI'|'Training', expires_on:'YYYY-MM-DD'}]
  credentials jsonb not null default '[]'::jsonb,
  services text[] not null default '{}',
  hired_on date,
  lat double precision,
  lng double precision,
  active boolean not null default true,
  declined_client_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists authorizations (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  service_code text not null,
  units_authorized int not null,
  units_used int not null default 0,
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now()
);

create table if not exists shifts (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  aide_id uuid references aides(id) on delete set null,
  service_code text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled', -- scheduled | open | filled | cancelled | completed
  open_since timestamptz,
  filled_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists shift_offers (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  shift_id uuid not null references shifts(id) on delete cascade,
  aide_id uuid not null references aides(id) on delete cascade,
  sent_at timestamptz,
  response text, -- yes | no
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (shift_id, aide_id)
);

create table if not exists visits (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  client_id uuid references clients(id) on delete set null,
  aide_id uuid references aides(id) on delete set null,
  shift_id uuid references shifts(id) on delete set null,
  service_code text not null,
  vendor_visit_key text,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  actual_start timestamptz,
  actual_end timestamptz,
  verification_status text not null default 'unverified', -- verified | unverified | exception
  gps_in_flag boolean,
  gps_out_flag boolean,
  units int,
  claim_status text not null default 'unbilled', -- unbilled | submitted | paid | denied
  denial_reason text,
  source text not null default 'manual', -- seed | sandata | generic | manual
  created_at timestamptz not null default now()
);
create unique index if not exists visits_vendor_key_uq on visits (agency_id, vendor_visit_key) where vendor_visit_key is not null;
create index if not exists visits_agency_start_idx on visits (agency_id, scheduled_start desc);

create table if not exists evv_exceptions (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  visit_id uuid not null references visits(id) on delete cascade,
  rule text not null,
  detail text,
  severity text not null default 'medium', -- low | medium | high
  opened_at timestamptz not null default now(),
  window_closes_at timestamptz,
  status text not null default 'open', -- open | corrected | dismissed
  corrected_at timestamptz,
  correction_note text,
  created_at timestamptz not null default now(),
  unique (visit_id, rule)
);
create index if not exists evv_exceptions_open_idx on evv_exceptions (agency_id, status, window_closes_at);

create table if not exists referrals (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  source_name text,
  source_org text,
  source_channel text not null default 'manual', -- email | phone | fax | portal | manual
  source_email text,
  client_name text,
  county text,
  service text,
  hours_per_week numeric,
  received_at timestamptz not null default now(),
  first_response_at timestamptz,
  responded_by text,
  capacity_confirmed_at timestamptz,
  intake_started_at timestamptz,
  care_started_at timestamptz,
  followup_7_at timestamptz,
  followup_30_at timestamptz,
  status text not null default 'new', -- new | responded | intake | active | declined | lost
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists applicants (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  phone text,
  email text,
  applied_at timestamptz not null default now(),
  source text not null default 'manual', -- csv | webhook | manual
  status text not null default 'new', -- new | screened | interview_booked | hired | rejected
  screen_answers jsonb not null default '{}'::jsonb,
  screen_score int,
  interview_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists proposed_actions (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  worker text not null,          -- authorization_watch | credential_tracking | open_shift_fill | referral_response | applicant_screening | retention_checkins
  kind text not null,            -- email | sms | task
  to_ref text,                   -- descriptor of recipient: 'scheduler', 'admin', 'aide:<id>', 'family:<client_id>', 'referrer:<referral_id>', 'applicant:<id>'
  subject text,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'proposed', -- proposed | approved | sent | skipped
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  sent_at timestamptz
);
create index if not exists proposed_actions_status_idx on proposed_actions (agency_id, status, created_at desc);

create table if not exists retention_checkins (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  aide_id uuid not null references aides(id) on delete cascade,
  day int not null, -- 30 | 60 | 90
  due_on date not null,
  status text not null default 'pending', -- pending | proposed | sent
  proposed_action_id uuid references proposed_actions(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (aide_id, day)
);

create table if not exists worker_runs (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references agencies(id) on delete cascade,
  worker text not null,
  dry_run boolean not null default true,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb not null default '{}'::jsonb
);

-- ---------------------------------------------------------------- triggers
do $$
declare t text;
begin
  foreach t in array array[
    'agencies','profiles','prospects','touches','assessments','trace_steps',
    'clients','aides','authorizations','shifts','shift_offers','visits','evv_exceptions',
    'referrals','applicants','proposed_actions','retention_checkins','worker_runs'
  ] loop
    execute format('drop trigger if exists %I on %I', 'audit_' || t, t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row()', 'audit_' || t, t);
  end loop;
  foreach t in array array['prospects','assessments'] loop
    execute format('drop trigger if exists %I on %I', 'touch_updated_' || t, t);
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', 'touch_updated_' || t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------- RLS
alter table agencies enable row level security;
alter table profiles enable row level security;
alter table audit_events enable row level security;
alter table prospects enable row level security;
alter table touches enable row level security;
alter table assessments enable row level security;
alter table trace_steps enable row level security;
alter table clients enable row level security;
alter table aides enable row level security;
alter table authorizations enable row level security;
alter table shifts enable row level security;
alter table shift_offers enable row level security;
alter table visits enable row level security;
alter table evv_exceptions enable row level security;
alter table referrals enable row level security;
alter table applicants enable row level security;
alter table proposed_actions enable row level security;
alter table retention_checkins enable row level security;
alter table worker_runs enable row level security;

-- profiles: a user sees their own row; staff sees all; nobody edits roles except staff.
drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles for select to authenticated
  using (id = auth.uid() or is_staff());
drop policy if exists profiles_staff_write on profiles;
create policy profiles_staff_write on profiles for all to authenticated
  using (is_staff()) with check (is_staff());

-- agencies: client sees own agency; staff sees all. Only staff writes.
drop policy if exists agencies_read on agencies;
create policy agencies_read on agencies for select to authenticated
  using (is_staff() or id = current_agency_id());
drop policy if exists agencies_staff_write on agencies;
create policy agencies_staff_write on agencies for all to authenticated
  using (is_staff()) with check (is_staff());

-- audit: staff read only. Rows are written by SECURITY DEFINER functions.
drop policy if exists audit_staff_read on audit_events;
create policy audit_staff_read on audit_events for select to authenticated using (is_staff());

-- staff-only tables
do $$
declare t text;
begin
  foreach t in array array['prospects','touches','worker_runs'] loop
    execute format('drop policy if exists %I on %I', t || '_staff_all', t);
    execute format('create policy %I on %I for all to authenticated using (is_staff()) with check (is_staff())', t || '_staff_all', t);
  end loop;
end $$;

-- tenant tables: "client sees only own agency; staff sees all"
do $$
declare t text;
begin
  foreach t in array array[
    'assessments','trace_steps','clients','aides','authorizations','shifts','shift_offers',
    'visits','evv_exceptions','referrals','applicants','proposed_actions','retention_checkins'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_tenant', t);
    execute format(
      'create policy %I on %I for all to authenticated using (is_staff() or agency_id = current_agency_id()) with check (is_staff() or agency_id = current_agency_id())',
      t || '_tenant', t);
  end loop;
end $$;

-- grants (Supabase grants these by default; harmless there, required locally)
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to authenticated, service_role;
grant all on all sequences in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;
revoke all on audit_events from authenticated;
grant select on audit_events to authenticated;
-- anon (public lead API) only inserts into prospects through a definer function below
revoke all on all tables in schema public from anon;

-- Public lead intake (site, evv-page, chat). SECURITY DEFINER so the anon role
-- never gets table access; dedupes on email + agency_name.
create or replace function public_create_lead(
  p_name text, p_email text, p_agency_name text, p_phone text, p_message text, p_source text,
  p_city text default null, p_county text default null, p_state text default 'OH'
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_agency text;
begin
  if p_source not in ('site','evv-page','chat') then
    raise exception 'invalid source';
  end if;
  v_agency := coalesce(nullif(trim(p_agency_name), ''), 'Unknown agency');
  select id into v_id from prospects
    where lower(email) = lower(p_email) and lower(agency_name) = lower(v_agency) limit 1;
  if v_id is null then
    insert into prospects (agency_name, owner_name, email, phone, city, county, state, source, stage)
    values (v_agency, p_name, p_email, p_phone, p_city, p_county, coalesce(p_state,'OH'), p_source, 'new')
    returning id into v_id;
  end if;
  insert into touches (prospect_id, channel, direction, subject, body, meta)
  values (v_id, case when p_source = 'chat' then 'chat'::touch_channel else 'site'::touch_channel end,
          'inbound', 'Lead from ' || p_source, p_message, jsonb_build_object('source', p_source));
  return v_id;
end $$;
grant execute on function public_create_lead(text,text,text,text,text,text,text,text,text) to anon, authenticated, service_role;

-- Supabase: create a profile row for every new auth user. Staff emails come
-- from app.staff_emails (set via: alter database postgres set app.staff_emails = 'a@x,b@y').
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role user_role := 'client';
begin
  if position(lower(new.email) in lower(coalesce(current_setting('app.staff_emails', true), ''))) > 0 then
    v_role := 'staff';
  end if;
  insert into profiles (id, email, role) values (new.id, new.email, v_role)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();
