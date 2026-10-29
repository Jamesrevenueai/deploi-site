-- Rollback of 20261029000034_agent_library.sql (run after _guard.sql, inside one transaction).
select pg_temp.assert_empty('beta_feedback');
select pg_temp.assert_empty('custom_agents');
select pg_temp.assert_empty('library_chat_messages');
select pg_temp.assert_empty('library_usage');
select pg_temp.assert_empty('library_actions');
select pg_temp.assert_empty('library_auto_run_grants');
select pg_temp.assert_empty('library_switches');
drop table if exists beta_feedback;
drop table if exists custom_agents;
drop table if exists library_chat_messages;
drop table if exists library_usage;
drop table if exists library_actions;
drop table if exists library_auto_run_grants;
drop table if exists library_switches;
alter table agencies drop constraint if exists agencies_plan_tier_chk;
alter table agencies drop column if exists plan_tier;
alter table agencies drop column if exists plan_changed_at;
alter table agencies drop column if exists onboarding;
