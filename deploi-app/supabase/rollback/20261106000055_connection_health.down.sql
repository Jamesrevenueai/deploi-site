-- Rollback of 20261106000055_connection_health.sql. Health history and state are refused while they hold
-- rows unless deploi.rollback_discard_data = 'on'. Nothing else depends on them: the integrations page
-- falls back to the connection rows' own status.
select pg_temp.assert_empty('connection_health');
select pg_temp.assert_empty('connection_health_state');
drop table if exists connection_health_state;
drop table if exists connection_health;
