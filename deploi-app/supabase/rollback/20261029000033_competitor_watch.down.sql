-- Rollback of 20261029000033_competitor_watch.sql (run after _guard.sql, inside one transaction).
select pg_temp.assert_empty('competitor_findings');
select pg_temp.assert_empty('competitor_checks');
select pg_temp.assert_empty('competitor_products');
select pg_temp.assert_empty('competitor_sources');
drop table if exists competitor_findings;
drop table if exists competitor_checks;
drop table if exists competitor_products;
drop table if exists competitor_sources;
