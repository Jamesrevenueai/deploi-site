-- Rollback of 20261104000042_legal_billing.sql (run after _guard.sql, inside one transaction).
-- Drops legal acceptance evidence and billing state.
-- Acceptances are legal evidence: export them first (select * from legal_acceptances) and keep the export.
-- Refuses to drop a table holding rows unless: set deploi.rollback_discard_data = 'on';
-- The security hardening (F-01 .. F-05) is deliberately NOT reverted: undoing it would reopen the findings.
select pg_temp.assert_empty('legal_acceptances');
select pg_temp.assert_empty('billing_subscriptions');
select pg_temp.assert_empty('billing_customers');
select pg_temp.assert_empty('billing_events');
drop table if exists billing_events;
drop table if exists billing_subscriptions;
drop table if exists billing_customers;
drop table if exists legal_acceptances;
drop function if exists legal_acceptances_append_only();
drop table if exists legal_documents;
