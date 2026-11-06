-- Rollback of 20261105000045_resolution_engine.sql. Cases are the customer's work history: refused while any
-- exist unless deploi.rollback_discard_data = 'on'.
select pg_temp.assert_empty('cases');
drop table if exists case_links;
drop table if exists case_events;
drop table if exists cases;
drop function if exists case_events_append_only();
drop sequence if exists case_number_seq;
