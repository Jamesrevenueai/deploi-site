-- Rollback of 20261105000047_office_resolution.sql. Email Operations agents (and their policies, actions and
-- runs, which cascade) are the customer's configuration and history: refused while any exist unless
-- deploi.rollback_discard_data = 'on', in which case they are deleted before the kind is removed.
do $$ declare n bigint; begin
  select count(*) into n from office_agents where kind = 'email_operations';
  if n > 0 and coalesce(current_setting('deploi.rollback_discard_data', true), '') <> 'on' then
    raise exception 'rollback refused: office_agents has % Email Operations agent(s); set deploi.rollback_discard_data = ''on'' to discard them', n;
  end if;
  update office_agents set active_policy_id = null where kind = 'email_operations';
  delete from office_agents where kind = 'email_operations';
end $$;
alter table office_agents drop constraint if exists office_agents_kind_check;
alter table office_agents add constraint office_agents_kind_check
  check (kind in ('lead_followup', 'meeting_scheduler', 'crm_updater', 'customer_reply'));
