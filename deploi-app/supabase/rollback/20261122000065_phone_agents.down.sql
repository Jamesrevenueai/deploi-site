-- Rollback of 20261122000065_phone_agents.sql (run after _guard.sql, inside one transaction).
-- Refused while the phone tables hold rows unless deploi.rollback_discard_data = 'on'.
select pg_temp.assert_empty('phone_texts');
select pg_temp.assert_empty('phone_calls');
select pg_temp.assert_empty('office_phone_lines');
delete from notify_outbox where audience = 'customer';
alter table notify_outbox drop constraint if exists notify_outbox_audience_check;
alter table notify_outbox add constraint notify_outbox_audience_check check (audience in ('owner', 'crew'));
delete from agent_events where source = 'phone';
alter table agent_events drop constraint if exists agent_events_source_check;
alter table agent_events add constraint agent_events_source_check
  check (source in ('shopify', 'outlook', 'calendar', 'crm', 'quickbooks', 'buildium', 'mailbox', 'sweep', 'crew', 'manual'));
drop table if exists phone_texts;
drop table if exists phone_calls;
drop table if exists office_phone_lines;
drop function if exists public_create_office_signup(text,text,text,text,text,text,text[],text,text);
