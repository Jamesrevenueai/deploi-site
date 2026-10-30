/**
 * Consulting-only migrations after the foundation: job_runs, action execution, imports and EVV rule sets, economics,
 * service tickets, website engagements. Nothing uses what they create. scripts/migrate.ts skips them on any database that
 * has not already applied them, so a normal migrate run can never build (or alter) the retired care tables, including
 * on a database whose care tables have been archived. The launch migrations (28 and later) do not depend on them.
 */
export const RETIRED_MIGRATIONS: readonly string[] = [
  '20261021000022_job_runs.sql',
  '20261021000023_action_execution.sql',
  '20261021000024_imports_evv_rules.sql',
  '20261021000025_economics.sql',
  '20261021000026_service_tickets.sql',
  '20261021000027_website.sql',
]
