-- Rollback of 20261028000030_agents.sql
select pg_temp.assert_empty('agents');
select pg_temp.assert_empty('reference_sources');
-- engine rows written by agents reference agent ids; the columns go with the tables
drop index if exists executions_agent_day_idx;
drop index if exists proposals_agent_idx;
alter table executions drop column if exists qualification, drop column if exists after_value, drop column if exists before_value,
  drop column if exists policy_version, drop column if exists policy_id, drop column if exists agent_id;
alter table approvals drop column if exists qualification, drop column if exists policy_version, drop column if exists policy_id;
alter table proposals drop column if exists policy_version, drop column if exists policy_id, drop column if exists agent_id;
alter table issues drop column if exists agent_id;
alter table scans drop column if exists agent_id;
-- standing-authorization approvals and queued executions only exist with agents
delete from approvals where approver_kind = 'standing_authorization';
alter table approvals drop constraint if exists approvals_approver_kind_check;
alter table approvals add constraint approvals_approver_kind_check check (approver_kind in ('profile', 'shopify_user'));
delete from executions where status = 'queued';
alter table executions drop constraint if exists executions_status_check;
alter table executions add constraint executions_status_check check (status in (
  'prechecking', 'blocked', 'stale', 'executing', 'applied', 'unknown', 'verified', 'failed', 'verification_failed'));
drop index if exists issues_live_fingerprint;
create unique index if not exists issues_live_fingerprint on issues (connection_id, fingerprint) where status in ('open', 'needs_review');
alter table agents drop constraint if exists agents_active_policy_fk;
drop table if exists reference_rows;
drop table if exists reference_sources;
drop table if exists agent_runs;
drop table if exists agent_policies;
drop table if exists agents;
alter table store_connections drop column if exists currency;
