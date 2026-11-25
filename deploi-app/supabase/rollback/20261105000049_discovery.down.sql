-- Rollback of 20261105000049_discovery.sql. Discovery runs and profiles can be rebuilt by running discovery
-- again, but the agent links record what one-click setup created: refused while any exist unless
-- deploi.rollback_discard_data = 'on'.
select pg_temp.assert_empty('discovery_agents');
drop table if exists discovery_agents;
drop table if exists business_profiles;
drop table if exists discovery_runs;
