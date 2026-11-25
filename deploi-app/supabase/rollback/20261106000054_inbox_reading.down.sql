-- Rollback of 20261106000054_inbox_reading.sql (run after _guard.sql, inside one transaction).
-- Refuses while inbox sync state, sender rules or mail read from Gmail / Outlook inboxes exist, unless
-- deploi.rollback_discard_data = 'on' (then the sync state and rules are dropped, and inbound mail read from
-- provider inboxes is deleted: the pre-migration code cannot tell it apart from agent-mailbox mail).
select pg_temp.assert_empty('email_sync_state');
select pg_temp.assert_empty('email_sender_rules');
create or replace function pg_temp.assert_none(t text, w text) returns void language plpgsql as $$
declare n bigint;
begin
  if to_regclass(t) is null then return; end if;
  execute format('select count(*) from %s where %s', t, w) into n;
  if n > 0 and coalesce(current_setting('deploi.rollback_discard_data', true), '') <> 'on' then
    raise exception 'rollback refused: % has % row(s) where %; set deploi.rollback_discard_data = ''on'' to discard them', t, n, w;
  end if;
end $$;
select pg_temp.assert_none('email_inbound', $w$account_id in (select id from email_accounts where provider in ('gmail', 'microsoft'))$w$);
select pg_temp.assert_none('email_inbound', $w$first_contact or released_at is not null$w$);
delete from email_inbound where account_id in (select id from email_accounts where provider in ('gmail', 'microsoft'));
drop table if exists email_sender_rules;
drop table if exists email_sync_state;
alter table email_oauth_states drop column if exists want_inbox;
drop index if exists email_inbound_first_contact_idx;
drop index if exists email_inbound_thread_idx;
alter table email_inbound drop column if exists answered_at;
alter table email_inbound drop column if exists released_at;
alter table email_inbound drop column if exists released_by;
alter table email_inbound drop column if exists quarantine_code;
alter table email_inbound drop column if exists first_contact;
alter table email_inbound drop column if exists provider_message_id;
alter table email_inbound drop column if exists provider_thread_id;
