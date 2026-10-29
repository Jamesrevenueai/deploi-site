-- Rollback of 20261029000034_store_eligibility.sql (run after _guard.sql, inside one transaction).
-- Live writes then fall back to LIVE_WRITE_STORES / LIVE_WRITES only.
select pg_temp.assert_empty('store_eligibility');
drop table if exists store_eligibility;
