-- One crew roster: crew_members (Settings -> Crew; what notifyCrew, crew_jobs and the /crew/done links use).
-- A home-services or office job now names a crew_members row. pack_crew_members stays in place but is DEPRECATED:
-- nothing reads or writes it any more (it keeps its privacy and export entries until it is dropped in a later release).
-- Existing pack crew are copied into crew_members (role 'field'), and each job is pointed at the copy.
-- Idempotent.

-- copy each pack crew member once (matched by organization + name + email), so jobs keep their crew
insert into crew_members (org_id, name, role, email, phone, channels, active)
select p.org_id, p.name, 'field',
  case when p.email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then lower(p.email) else null end,
  case when regexp_replace(coalesce(p.phone, ''), '[^0-9+]', '', 'g') ~ '^\+[1-9][0-9]{6,14}$' then regexp_replace(p.phone, '[^0-9+]', '', 'g') else null end,
  array['email']::text[], p.active
from pack_crew_members p
where not exists (select 1 from crew_members c where c.org_id = p.org_id and c.name = p.name and coalesce(c.email, '') = coalesce(lower(p.email), ''));

alter table pack_work_orders drop constraint if exists pack_work_orders_crew_member_id_fkey;
update pack_work_orders w set crew_member_id = (
    select c.id from pack_crew_members p join crew_members c on c.org_id = p.org_id and c.name = p.name and coalesce(c.email, '') = coalesce(lower(p.email), '')
    where p.id = w.crew_member_id order by c.created_at limit 1)
  where w.crew_member_id is not null and not exists (select 1 from crew_members c where c.id = w.crew_member_id);
alter table pack_work_orders add constraint pack_work_orders_crew_member_id_fkey foreign key (crew_member_id) references crew_members(id) on delete set null;

comment on table pack_crew_members is 'DEPRECATED (20261107000062): the crew roster is crew_members. Not read or written; kept for export/erase until dropped.';
