-- Rollback of 20261104000044_rate_limits.sql. The counters are short-lived; dropping them loses nothing
-- but the current windows (every limit starts again from zero). With the table gone the limiter fails open.
drop function if exists rate_limits_cleanup(integer);
drop function if exists rate_limit_hit(text, text, integer, integer, timestamptz);
drop table if exists rate_limits;
