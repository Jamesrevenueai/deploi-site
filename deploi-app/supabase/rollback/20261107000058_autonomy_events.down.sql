-- Rollback of 20261107000058_autonomy_events.sql. Owner autonomy settings, routed events, agent loops (with the
-- owner's approvals) and undo links are refused while they hold rows unless deploi.rollback_discard_data = 'on',
-- so nothing is lost silently.
select pg_temp.assert_empty('undo_tokens');
select pg_temp.assert_empty('agent_loops');
select pg_temp.assert_empty('agent_events');
select pg_temp.assert_empty('org_action_modes');
drop table if exists undo_tokens;
drop table if exists agent_loops;
drop table if exists agent_events;
drop table if exists org_action_modes;
