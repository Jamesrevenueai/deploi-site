-- Rollback of 20261106000056_billing_lifecycle.sql. Trial, payment-failure, plan-change and notice records are
-- refused while they hold rows unless deploi.rollback_discard_data = 'on'. The added subscription columns are
-- dropped (Stripe keeps the authoritative copy; the next webhook rebuilds status, plan and period end).
select pg_temp.assert_empty('billing_trials');
select pg_temp.assert_empty('billing_payment_failures');
select pg_temp.assert_empty('billing_plan_changes');
select pg_temp.assert_empty('billing_notices');
drop table if exists billing_notices;
drop table if exists billing_plan_changes;
drop table if exists billing_payment_failures;
drop table if exists billing_trials;
alter table billing_customers drop column if exists email_hash;
alter table billing_subscriptions drop column if exists last_invoice_event_at;
alter table billing_subscriptions drop column if exists pending_change_at;
alter table billing_subscriptions drop column if exists pending_plan_key;
alter table billing_subscriptions drop column if exists schedule_external_id;
alter table billing_subscriptions drop column if exists ended_at;
alter table billing_subscriptions drop column if exists canceled_at;
alter table billing_subscriptions drop column if exists cancel_requested_at;
alter table billing_subscriptions drop column if exists cancel_comment;
alter table billing_subscriptions drop column if exists cancel_reason;
alter table billing_subscriptions drop column if exists trial_start;
alter table billing_subscriptions drop column if exists item_external_id;
alter table billing_subscriptions drop column if exists price_external_id;
alter table billing_subscriptions drop column if exists plan_key;
