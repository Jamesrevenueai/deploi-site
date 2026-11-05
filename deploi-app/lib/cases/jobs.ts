/**
 * Durable case checks: the cron sweep queues one `case.check` job per due case (idempotent per case and due
 * time), and the job runs the kind's checker. Checks are agent work: an organization stop cancels them.
 */
import { admin } from '../db'
import { enqueue, registerJobHandler, type EnqueueResult } from '../jobs/queue'
import { dueCases, runCaseCheck } from './index'
// case kinds with a checker register themselves on import
import '../office/receivables'
import '../office/resolution'
import '../connectors'
import { registerEngineCaseKinds } from '../engine/case-sync'
import '../agents/case-sync'
import '../library/case-sync'
import '../competitors/case-sync'
registerEngineCaseKinds()

registerJobHandler('case.check', async payload => {
  const caseId = String(payload.caseId ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(caseId)) return { skipped: true, reason: 'invalid case id' }
  return runCaseCheck(caseId)
}, { leaseMs: 3 * 60_000, maxAttempts: 3 })

export async function enqueueDueCases(now = new Date(), limit = 200): Promise<EnqueueResult[]> {
  const due = await admin(db => db.query<{ id: string; org_id: string; next_check_at: string }>(
    `select id, org_id, next_check_at from cases where next_check_at <= $1 and status not in ('resolved','cancelled','failed') order by next_check_at limit $2`, [now.toISOString(), limit]))
  const out: EnqueueResult[] = []
  for (const c of due) out.push(await enqueue({ kind: 'case.check', orgId: c.org_id, payload: { caseId: c.id }, idempotencyKey: `${c.id}@${new Date(c.next_check_at).toISOString()}` }))
  return out
}
export { dueCases }
