-- Rollback of 20261028000032_agent_platform.sql (run after _guard.sql, inside one transaction).
select pg_temp.assert_empty('weekly_summaries');
select pg_temp.assert_empty('agent_tasks');
select pg_temp.assert_empty('email_inbound');
do $$ begin
  if exists (select 1 from email_accounts where provider = 'deploi') or exists (select 1 from email_messages where task_key = 'supplier_followup') then
    if coalesce(current_setting('deploi.rollback_discard_data', true), '') <> 'on' then
      raise exception 'rollback refused: agent mailboxes or supplier follow-ups exist; set deploi.rollback_discard_data = ''on'' to discard them';
    end if;
  end if;
end $$;
drop table if exists weekly_summaries;
drop table if exists agent_tasks;
drop table if exists inbound_webhook_events;
drop table if exists email_inbound;
delete from email_messages where task_key = 'supplier_followup';
delete from email_messages where account_id in (select id from email_accounts where provider = 'deploi');
delete from email_accounts where provider = 'deploi';
drop index if exists email_messages_reply_token;
alter table email_messages drop column if exists reply_token;
alter table email_messages drop column if exists in_reply_to;
alter table email_messages drop constraint if exists email_messages_task_key_check;
alter table email_messages add constraint email_messages_task_key_check check (task_key in ('run_report', 'needs_person_alert', 'supplier_reorder'));
drop index if exists email_accounts_deploi_address;
drop index if exists email_accounts_one_mailbox_per_agent;
alter table email_accounts drop column if exists agent_id;
alter table email_accounts drop constraint if exists email_accounts_provider_check;
alter table email_accounts add constraint email_accounts_provider_check check (provider in ('gmail', 'microsoft', 'synthetic'));
