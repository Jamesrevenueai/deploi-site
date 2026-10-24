-- Phase 15: staff service queue + a definer helper so the client dashboard can show the last worker run
-- without reading the staff-only worker_runs table.

create table if not exists service_tickets (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references agencies(id) on delete cascade,
  engagement_ref text,
  title text not null,
  detail text,
  severity text not null default 'medium' check (severity in ('low','medium','high','urgent')),
  classification text not null default 'support_request' check (classification in ('defect','support_request','new_scope')),
  owner text,
  status text not null default 'open' check (status in ('open','in_progress','waiting_on_agency','resolved','closed')),
  next_action text,
  resolution text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists service_tickets_status_idx on service_tickets (status, severity, created_at desc);
create index if not exists service_tickets_agency_idx on service_tickets (agency_id, created_at desc);
alter table service_tickets enable row level security;
drop policy if exists service_tickets_staff_all on service_tickets;
create policy service_tickets_staff_all on service_tickets for all to authenticated using (is_staff()) with check (is_staff());
grant all on service_tickets to authenticated, service_role;
drop trigger if exists audit_service_tickets on service_tickets;
create trigger audit_service_tickets after insert or update or delete on service_tickets for each row execute function audit_row();
drop trigger if exists touch_updated_service_tickets on service_tickets;
create trigger touch_updated_service_tickets before update on service_tickets for each row execute function set_updated_at();

-- Last finished worker run for an agency (timestamp + worker name only). Callable by that agency's
-- client users and by staff; worker_runs itself stays staff-only.
create or replace function agency_last_worker_run(p_agency uuid)
returns table (worker text, finished_at timestamptz)
language sql stable security definer set search_path = public as $$
  select w.worker, w.finished_at
  from worker_runs w
  where w.agency_id = p_agency and w.finished_at is not null and w.dry_run = false
    and (is_staff() or current_agency_id() = p_agency)
  order by w.finished_at desc limit 1
$$;
grant execute on function agency_last_worker_run(uuid) to authenticated, service_role;
