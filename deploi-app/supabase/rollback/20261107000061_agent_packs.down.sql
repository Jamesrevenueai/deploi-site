-- Rollback of 20261107000061_agent_packs.sql (run after _guard.sql, inside one transaction).
-- Removes the agent packs. Every table that holds a customer's work (leads, messages, jobs, move-ins,
-- commission invoices and payments, maintenance requests, what each agent did) is refused while it holds rows
-- unless deploi.rollback_discard_data = 'on'. The synthetic provider state is test data and is dropped with it.
select pg_temp.assert_empty('pack_settings');
select pg_temp.assert_empty('pack_activity');
select pg_temp.assert_empty('pack_messages');
select pg_temp.assert_empty('pack_appointments');
select pg_temp.assert_empty('pack_work_orders');
select pg_temp.assert_empty('pack_crew_members');
select pg_temp.assert_empty('leasing_payments');
select pg_temp.assert_empty('leasing_placements');
select pg_temp.assert_empty('leasing_invoices');
select pg_temp.assert_empty('leasing_listings');
select pg_temp.assert_empty('leasing_properties');
select pg_temp.assert_empty('leasing_companies');
select pg_temp.assert_empty('pm_maintenance_requests');
select pg_temp.assert_empty('pm_vendors');
select pg_temp.assert_empty('pack_leads');
drop table if exists pack_synthetic_state;
drop table if exists pm_maintenance_requests;
drop table if exists pm_vendors;
drop table if exists leasing_payments;
drop table if exists leasing_placements;
drop table if exists leasing_invoices;
drop table if exists leasing_listings;
drop table if exists leasing_properties;
drop table if exists leasing_companies;
drop table if exists pack_work_orders;
drop table if exists pack_crew_members;
drop table if exists pack_appointments;
drop table if exists pack_messages;
drop table if exists pack_leads;
drop table if exists pack_activity;
drop table if exists pack_settings;
