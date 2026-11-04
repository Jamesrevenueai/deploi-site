-- Rollback of 20261104000040_office.sql (run after _guard.sql, inside one transaction). Drops Deploi Office
-- (connections, credentials, agents, leads, meetings, actions) and its links on the email tables.
-- Refuses while office data exists unless deploi.rollback_discard_data = 'on'.
select pg_temp.assert_empty('office_actions');
select pg_temp.assert_empty('office_meetings');
select pg_temp.assert_empty('office_leads');
select pg_temp.assert_empty('office_agents');
select pg_temp.assert_empty('office_connections');
delete from email_messages where task_key = 'office';
drop index if exists email_messages_office_dedupe;
alter table email_messages drop column if exists office_action_id;
alter table email_messages drop column if exists office_agent_id;
alter table email_messages drop constraint if exists email_messages_task_key_check;
alter table email_messages add constraint email_messages_task_key_check check (task_key in ('run_report', 'needs_person_alert', 'supplier_reorder', 'supplier_followup', 'human_reply'));  -- 039 (customer inbox) is still applied when this runs
alter table email_accounts drop column if exists office_mailbox;
drop table if exists office_synthetic_state;
drop table if exists office_org_locks;
drop table if exists office_inbound_handled;
drop table if exists office_actions;
drop table if exists office_meetings;
drop table if exists office_leads;
drop table if exists office_runs;
alter table if exists office_agents drop constraint if exists office_agents_active_policy_fk;
drop table if exists office_agent_policies;
drop table if exists office_agents;
drop table if exists office_oauth_states;
drop table if exists office_credentials;
drop table if exists office_connections;
