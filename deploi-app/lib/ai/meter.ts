/**
 * Workflow execution cost: cheap monthly counters per organization (table workflow_costs).
 *
 *   job_run        every settled job of an organization (lib/jobs/queue.ts, in the job's own transaction)
 *   provider_call  every real call to a store provider API (Shopify GraphQL, WooCommerce REST); synthetic
 *                  stores are not counted. Counted in memory and flushed in batches (flushWorkflowCounters,
 *                  after every job and at the end of each cron worker run), so the hot path never waits on
 *                  the database. A crash can lose an unflushed batch: these are cost estimates, not billing.
 *   email_sent     every message the email provider accepted (lib/email/engine.ts)
 *
 * Unit prices for reporting live in lib/platform/economics.ts (environment).
 */
import { admin, type Db } from '../db'

export type WorkflowMetric = 'job_run' | 'provider_call' | 'email_sent'

const pending = new Map<string, number>()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const monthOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`

/** Count in memory (no I/O). */
export function countWorkflow(orgId: string | null | undefined, metric: WorkflowMetric, connector = '', n = 1) {
  if (!orgId || !UUID.test(orgId) || n <= 0) return
  const k = `${orgId}|${metric}|${connector}`
  pending.set(k, (pending.get(k) ?? 0) + n)
}

/** Add to the month's counter in the caller's transaction. */
export async function recordWorkflow(db: Db, orgId: string, metric: WorkflowMetric, connector = '', n = 1, now = new Date()) {
  await db.query(
    `insert into workflow_costs (org_id, month, metric, connector, count) select $1, $2::date, $3, $4, $5 where exists (select 1 from agencies where id = $1)
     on conflict (org_id, month, metric, connector) do update set count = workflow_costs.count + excluded.count, updated_at = now()`,
    [orgId, monthOf(now), metric, connector, n])
}

/** Write the in-memory counts. Never throws (a failed flush keeps the counts for the next one). */
export async function flushWorkflowCounters(now = new Date()): Promise<number> {
  if (!pending.size) return 0
  const batch = [...pending.entries()]
  pending.clear()
  try {
    await admin(async db => {
      for (const [k, n] of batch) {
        const [orgId, metric, connector] = k.split('|')
        await recordWorkflow(db, orgId, metric as WorkflowMetric, connector, n, now)
      }
    })
    return batch.length
  } catch {
    for (const [k, n] of batch) pending.set(k, (pending.get(k) ?? 0) + n)
    return 0
  }
}

/** Tests: what is waiting to be flushed. */
export const pendingWorkflowCounts = () => new Map(pending)
