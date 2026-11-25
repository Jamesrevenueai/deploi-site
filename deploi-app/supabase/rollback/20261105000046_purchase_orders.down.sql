-- Rollback of 20261105000046_purchase_orders.sql. Purchase orders, their resolutions and supplier replies are
-- the customer's records: refused while any exist unless deploi.rollback_discard_data = 'on'.
select pg_temp.assert_empty('supplier_replies');
select pg_temp.assert_empty('purchase_order_resolutions');
select pg_temp.assert_empty('purchase_order_lines');
select pg_temp.assert_empty('purchase_orders');
do $$ begin
  if exists (select 1 from email_messages where task_key = 'supplier_exception')
     and coalesce(current_setting('deploi.rollback_discard_data', true), '') <> 'on' then
    raise exception 'rollback refused: email_messages has Supplier Coordinator messages; set deploi.rollback_discard_data = ''on'' to discard them';
  end if;
end $$;
delete from email_messages where task_key = 'supplier_exception';
alter table email_messages drop constraint if exists email_messages_task_key_check;
alter table email_messages add constraint email_messages_task_key_check
  check (task_key in ('run_report', 'needs_person_alert', 'supplier_reorder', 'supplier_followup', 'human_reply', 'office'));
drop table if exists supplier_replies;
drop table if exists purchase_order_resolutions;
drop table if exists purchase_order_lines;
drop table if exists purchase_orders;
