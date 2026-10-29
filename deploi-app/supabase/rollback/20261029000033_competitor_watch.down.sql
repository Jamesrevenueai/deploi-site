-- Rollback of 20261029000033_competitor_watch.sql (run after _guard.sql, inside one transaction).
select pg_temp.assert_empty('competitor_insights');
select pg_temp.assert_empty('competitor_stores');
do $$ begin
  if exists (select 1 from email_messages where task_key in ('competitor_alert', 'sourcing_request')) then
    if coalesce(current_setting('deploi.rollback_discard_data', true), '') <> 'on' then
      raise exception 'rollback refused: competitor alerts or sourcing requests exist; set deploi.rollback_discard_data = ''on'' to discard them';
    end if;
  end if;
end $$;
drop table if exists competitor_insights;
drop table if exists competitor_changes;
drop table if exists competitor_observations;
drop table if exists competitor_products;
drop table if exists competitor_checks;
drop table if exists competitor_stores;
delete from email_messages where task_key in ('competitor_alert', 'sourcing_request');
alter table email_messages drop constraint if exists email_messages_task_key_check;
alter table email_messages add constraint email_messages_task_key_check check (task_key in ('run_report', 'needs_person_alert', 'supplier_reorder', 'supplier_followup'));
