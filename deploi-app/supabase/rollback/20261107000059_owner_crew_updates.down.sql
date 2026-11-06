-- Rollback of 20261107000059_owner_crew_updates.sql. The record of owner updates, crew, crew jobs and their
-- messages, text/voice messages, preferences and morning reports is refused while it holds rows unless
-- deploi.rollback_discard_data = 'on', so nothing is lost silently.
select pg_temp.assert_empty('morning_reports');
select pg_temp.assert_empty('crew_job_links');
select pg_temp.assert_empty('crew_messages');
select pg_temp.assert_empty('crew_jobs');
select pg_temp.assert_empty('crew_members');
select pg_temp.assert_empty('notify_outbox');
select pg_temp.assert_empty('owner_updates');
select pg_temp.assert_empty('notify_preferences');
drop table if exists morning_reports;
drop table if exists crew_job_links;
drop table if exists crew_messages;
drop table if exists crew_jobs;
drop table if exists crew_members;
drop table if exists notify_outbox;
drop table if exists owner_updates;
drop table if exists notify_preferences;
