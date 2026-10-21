/**
 * Job lock: a scheduled job runs at most once per (jobKey, periodKey). A second caller in the same
 * period gets { skipped: true } and runs nothing. Use the agency-local date as periodKey for daily jobs.
 * Must be called inside admin() (service role); the insert is the lock. A throwing fn is recorded as
 * failed and returned as { error } rather than rethrown, so the caller's transaction commits the lock row.
 */
import type { Db } from '../db'

export type JobOutcome<T> = { skipped: true; reason: 'already_ran' } | { skipped: false; runId: string; result: T; error?: undefined } | { skipped: false; runId: string; result?: undefined; error: string }

export async function withJobLock<T>(db: Db, jobKey: string, periodKey: string, fn: () => Promise<T>): Promise<JobOutcome<T>> {
  const row = await db.one<{ id: string }>(
    `insert into job_runs (job_key, period_key) values ($1, $2) on conflict (job_key, period_key) do nothing returning id`, [jobKey, periodKey])
  if (!row) return { skipped: true, reason: 'already_ran' }
  try {
    const result = await fn()
    await db.query(`update job_runs set status = 'done', finished_at = now(), summary = $2 where id = $1`, [row.id, JSON.stringify(summaryOf(result))])
    return { skipped: false, runId: row.id, result }
  } catch (e) {
    // The lock row is kept (and committed by the caller) so the failure is visible and the period is not silently re-run.
    const error = (e as Error).message.slice(0, 200)
    await db.query(`update job_runs set status = 'failed', finished_at = now(), summary = $2 where id = $1`, [row.id, JSON.stringify({ error })])
    return { skipped: false, runId: row.id, error }
  }
}

function summaryOf(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return { result: Array.isArray(v) ? v.length : v ?? null }
}
