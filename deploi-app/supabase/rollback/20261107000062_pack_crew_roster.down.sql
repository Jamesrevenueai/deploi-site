-- Rollback of 20261107000062_pack_crew_roster.sql (run after _guard.sql, inside one transaction).
-- Points pack_work_orders.crew_member_id back at pack_crew_members. A job whose crew member exists only in
-- crew_members loses its crew assignment (set null); the crew_members rows copied by the migration are kept
-- (they are the business's own roster in Settings -> Crew).
alter table pack_work_orders drop constraint if exists pack_work_orders_crew_member_id_fkey;
update pack_work_orders w set crew_member_id = null where crew_member_id is not null and not exists (select 1 from pack_crew_members p where p.id = w.crew_member_id);
alter table pack_work_orders add constraint pack_work_orders_crew_member_id_fkey foreign key (crew_member_id) references pack_crew_members(id) on delete set null;
comment on table pack_crew_members is null;
