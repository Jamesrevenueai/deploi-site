/**
 * Reconciliation of store writes interrupted by a crash or a timeout (run from the job queue).
 *  - queued: an agent run approved the change and queued it, then stopped. executeProposal starts it
 *    through the normal path (every gate, fresh read, recheck), once (the queued row is claimed).
 *  - prechecking: the worker stopped before the write was claimed, so nothing was written. The row is
 *    put back to queued and goes through the same path, again re-reading the record first.
 *  - executing: the worker stopped after claiming the write, so it may or may not have been made. It is
 *    never repeated blindly: it becomes "unknown" for the merchant, whose retry re-reads the record
 *    (an already-made change is then reported, not written twice).
 */
import { admin } from '../db'
import { audit } from './audit'
import { executeProposal, type ExecutionResult } from './execute'

export async function recoverInterruptedExecutions(opts: { now?: Date; staleMs?: number; limit?: number; actor?: string } = {}): Promise<{ resumed: ExecutionResult[]; markedUnknown: number }> {
  const now = opts.now ?? new Date()
  const before = new Date(now.getTime() - (opts.staleMs ?? 15 * 60e3)).toISOString()
  const actor = opts.actor ?? 'system:recovery'
  const { requeued, unknown } = await admin(async db => {
    const unknown = await db.query<{ id: string; org_id: string; connection_id: string; proposal_id: string }>(
      `update executions set status = 'unknown', status_reason = 'the write was interrupted; Deploi cannot tell whether it was made. Retry re-reads the record first.', finished_at = now()
       where status = 'executing' and started_at < $1 returning id, org_id, connection_id, proposal_id`, [before])
    for (const u of unknown) await audit(db, { orgId: u.org_id, connectionId: u.connection_id, entityType: 'execution', entityId: u.id, event: 'execution.unknown', actor, detail: { reason: 'interrupted during the write', proposal_id: u.proposal_id } })
    const back = await db.query<{ id: string }>(`update executions set status = 'queued', status_reason = 'interrupted before writing; resuming' where status = 'prechecking' and started_at < $1 returning id`, [before])
    const queued = await db.query<{ proposal_id: string }>(
      `select e.proposal_id from executions e where e.status = 'queued' and (e.started_at < $1 or e.id = any($2::uuid[])) order by e.started_at limit $3`, [before, back.map(b => b.id), opts.limit ?? 50])
    return { requeued: queued.map(q => q.proposal_id), unknown: unknown.length }
  })
  const resumed: ExecutionResult[] = []
  for (const p of requeued) resumed.push(await executeProposal(p, { actor, now }))
  return { resumed, markedUnknown: unknown }
}
