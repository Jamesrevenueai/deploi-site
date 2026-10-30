-- Rollback of 20261030000035_role_switch_grants.sql: nothing to undo. The migration only lets the connection role
-- switch into anon/authenticated/service_role where it could not already; revoking that would break request transactions.
select 1;
