/**
 * Platform job kinds (registered on the durable queue when this module is imported):
 *
 *   platform.retention   the daily retention pass (lib/platform/retention.ts); queued once per UTC day
 *   platform.deletion    organization deletions whose cooling-off period ended (lib/platform/deletion.ts);
 *                        queued once per ten-minute window while any is due
 * Both are maintenance (agentWork: false), carry no organization id (so a deletion never deletes its own
 * job row) and are safe to run twice: the cron (/api/cron/jobs, hourly) queues them with idempotency keys.
 */
import { admin } from '../db'
import { enqueue, registerJobHandler, type EnqueueResult } from '../jobs/queue'
import { runRetention } from './retention'
import { executeDueDeletions } from './deletion'

registerJobHandler('platform.retention', async () => ({ ...(await runRetention()) }), { maxAttempts: 3, agentWork: false, leaseMs: 10 * 60_000 })

registerJobHandler('platform.deletion', async () => {
  const r = await executeDueDeletions()
  return { completed: r.filter(x => x.status === 'completed').length, failed: r.filter(x => x.status === 'failed').length }
}, { maxAttempts: 3, agentWork: false, leaseMs: 10 * 60_000 })

export async function enqueuePlatformWork(now = new Date()): Promise<EnqueueResult[]> {
  const out: EnqueueResult[] = []
  out.push(await enqueue({ kind: 'platform.retention', idempotencyKey: `retention@${now.toISOString().slice(0, 10)}` }))
  const due = await admin(db => db.one<{ n: string }>(`select count(*)::text as n from org_deletion_requests where status in ('pending','failed') and execute_after <= $1 and attempts < 10`, [now.toISOString()]))
  if (Number(due?.n ?? 0) > 0) {
    const slot = new Date(Math.floor(now.getTime() / 600e3) * 600e3).toISOString()
    out.push(await enqueue({ kind: 'platform.deletion', idempotencyKey: `deletion@${slot}` }))
  }
  return out
}
