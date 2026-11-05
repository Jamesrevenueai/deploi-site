-- =============================================================================
-- Deploi Office on the Resolution Engine: the Email Operations agent kind.
-- CRM follow-up, meeting requests and CRM commitments are carried as cases (lib/cases, migration 45);
-- they need no new table. The only schema change is the new office agent kind 'email_operations'
-- (unanswered inbox messages -> email_unanswered cases, templated reply drafts, drafts only by default).
-- Rollback: supabase/rollback/20261105000047_office_resolution.down.sql
-- =============================================================================
alter table office_agents drop constraint if exists office_agents_kind_check;
alter table office_agents add constraint office_agents_kind_check
  check (kind in ('lead_followup', 'meeting_scheduler', 'crm_updater', 'customer_reply', 'email_operations'));
