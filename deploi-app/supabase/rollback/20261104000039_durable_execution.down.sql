-- Rollback of 20261104000039_durable_execution.sql. Run after supabase/rollback/_guard.sql in the same session:
-- tables that hold rows are refused unless `set deploi.rollback_discard_data = 'on'` was given.
select pg_temp.assert_empty('jobs');
select pg_temp.assert_empty('org_controls');
select pg_temp.assert_empty('email_suppressions');
select pg_temp.assert_empty('email_thread_state');

-- audit chain (the rows themselves are kept; only the chain columns go)
drop function if exists verify_engine_audit_chain(uuid);
drop trigger if exists engine_audit_chain_link on engine_audit;
drop trigger if exists engine_audit_guard on engine_audit;
drop function if exists engine_audit_chain_link();
drop function if exists engine_audit_guard();
drop function if exists engine_audit_row_hash(text, bigint, engine_audit);
drop index if exists engine_audit_chain_idx;
alter table engine_audit drop column if exists chain_seq;
alter table engine_audit drop column if exists prev_hash;
alter table engine_audit drop column if exists row_hash;
drop table if exists engine_audit_chain;

-- email (human replies are kept only if the old constraint still holds; refuse otherwise)
do $$ begin
  if exists (select 1 from email_messages where task_key = 'human_reply') and coalesce(current_setting('deploi.rollback_discard_data', true), '') <> 'on' then
    raise exception 'rollback refused: email_messages has human replies; set deploi.rollback_discard_data = ''on'' to discard them';
  end if;
end $$;
delete from email_messages where task_key = 'human_reply';
alter table email_messages drop constraint if exists email_messages_task_key_check;
alter table email_messages add constraint email_messages_task_key_check check (task_key in ('run_report', 'needs_person_alert', 'supplier_reorder', 'supplier_followup'));
drop index if exists email_messages_org_day_idx;
alter table email_inbound drop column if exists attachments;
alter table email_inbound drop column if exists auto_reply;
alter table email_inbound drop column if exists auto_reply_reason;

drop table if exists email_thread_state;
drop table if exists email_suppressions;
drop table if exists cron_heartbeats;
drop table if exists org_controls;
drop table if exists jobs;
