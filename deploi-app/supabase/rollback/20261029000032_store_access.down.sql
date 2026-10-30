-- Rollback of 20261029000032_store_access.sql (run after _guard.sql, inside one transaction).
select pg_temp.assert_empty('store_access');
select pg_temp.assert_empty('beta_invites');
drop table if exists store_access;
drop table if exists beta_invites;
alter table store_connections drop column if exists shop_gid;
