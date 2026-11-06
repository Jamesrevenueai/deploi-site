-- Rollback of 20261106000052_cases_everywhere.sql. A privacy export is a customer's data waiting for the
-- merchant to download it: refused while any exist unless deploi.rollback_discard_data = 'on'.
select pg_temp.assert_empty('privacy_exports');
drop table if exists privacy_exports;
-- case events: strictly append-only again
create or replace function case_events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'case_events are append-only';
end $$;
