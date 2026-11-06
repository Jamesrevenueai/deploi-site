-- Rollback of 20261106000057_operations.sql. Alerts (with who acknowledged them) and the record of which
-- path AI-assisted steps took are refused while they hold rows unless deploi.rollback_discard_data = 'on'.
-- Operational logs are diagnostics and are refused too, so nothing is lost silently.
select pg_temp.assert_empty('alerts');
select pg_temp.assert_empty('ai_assists');
select pg_temp.assert_empty('ops_logs');
drop table if exists ai_assists;
drop table if exists ops_logs;
drop table if exists alerts;
