-- Rollback of 20261107000064_app_redesign.sql (run after _guard.sql, inside one transaction).
-- The owner's standing instructions and chat history are refused while they hold rows unless
-- deploi.rollback_discard_data = 'on'. Agent colours, autonomy levels and workspace choices are presentation and
-- preference state: dropped (agents fall back to the organization's action modes; their grants are unchanged).
select pg_temp.assert_empty('agent_instructions');
select pg_temp.assert_empty('agent_chat_messages');
drop table if exists agent_chat_messages;
drop table if exists app_workspace_prefs;
drop table if exists agent_instructions;
drop table if exists agent_profiles;
alter table office_runs drop column if exists instructions;
