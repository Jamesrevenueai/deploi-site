-- Rollback of 20261105000051_platform.sql. Usage records, deletion requests and plan history are refused
-- while they hold rows unless deploi.rollback_discard_data = 'on'. Roles are dropped: every member regains
-- today's pre-migration rights (any member may grant).
select pg_temp.assert_empty('ai_usage');
select pg_temp.assert_empty('org_deletion_requests');
select pg_temp.assert_empty('plan_changes');
drop trigger if exists profiles_org_role on profiles;
drop function if exists profiles_org_role();
drop table if exists org_deletion_requests;
drop table if exists workflow_costs;
drop table if exists ai_budget_overrides;
drop table if exists ai_usage;
alter table agencies drop column if exists plan_key;
drop table if exists plan_changes;
drop table if exists plans;
alter table email_inbound drop column if exists body_purged_at;
alter table email_messages drop column if exists body_purged_at;
alter table agencies drop column if exists retention;
alter table agencies drop column if exists deleted_at;
alter table agencies drop column if exists members_can_approve;
alter table invites drop constraint if exists invites_org_role_chk;
alter table invites drop column if exists org_role;
alter table profiles drop constraint if exists profiles_org_role_chk;
alter table profiles drop column if exists org_role;
