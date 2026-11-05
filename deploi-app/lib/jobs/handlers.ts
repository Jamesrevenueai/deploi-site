/**
 * Built-in job kinds. Importing this module registers them.
 *
 *  agent.run          one scheduled agent run. Authorized at the moment it starts (a job queued before a
 *                     pause, revoke or stop does nothing). runAgent claims the run under the agent's row
 *                     lock and re-checks that it is still due, so a job that runs twice (lease expired
 *                     after a crash) runs the agent once; the second attempt is a recorded skip.
 *  email.send         one queued message: sendMessage moves a row Queued -> Sending once, so a repeat is a no-op.
 *  email.reconcile    interrupted and unknown sends (never resent blindly).
 *  engine.recover     interrupted store writes: queued/prechecking resume through every gate; a write that
 *                     may have happened becomes "unknown" for the merchant (lib/engine/recover.ts).
 *
 * enqueueDueWork() is what the cron calls: it turns due agents and queued messages into jobs with
 * idempotency keys (agent id + the due time; message id + attempt), so overlapping crons queue each once.
 */
import { admin } from '../db'
import { EngineError } from '../engine/errors'
import { authorizeAgentAction } from '../engine/authorize'
import { runAgent } from '../agents/run'
import { reconcileOpen, sendMessage } from '../email/engine'
import { recoverInterruptedExecutions } from '../engine/recover'
import { enqueue, registerJobHandler, type EnqueueResult } from './queue'

registerJobHandler('agent.run', async payload => {
  const agentId = String(payload.agentId ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return { skipped: true, reason: 'invalid agent id' }
  const az = await admin(db => authorizeAgentAction(db, { agentId, orgId: typeof payload.orgId === 'string' ? payload.orgId : null, action: { tool: 'run' } }))
  if (!az.ok) return { skipped: true, reason: az.reason, code: az.code }
  try {
    const r = await runAgent(agentId, { trigger: payload.trigger === 'manual' ? 'manual' : 'schedule', actor: 'system:jobs' })
    return { runId: r.runId, status: r.status, reason: r.reason ?? null }
  } catch (e) {
    // busy (already running or not due any more) and inactive are outcomes, not failures to retry
    if (e instanceof EngineError && ['busy', 'agent_inactive', 'not_found'].includes(e.code)) return { skipped: true, reason: e.message, code: e.code }
    throw e
  }
}, { leaseMs: 6 * 60_000, maxAttempts: 3 })

registerJobHandler('email.send', async payload => {
  const id = String(payload.messageId ?? '')
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { skipped: true, reason: 'invalid message id' }
  const r = await sendMessage(id, { actor: 'system:jobs' })
  return { status: r.status, reason: r.reason ?? null, duplicate: r.duplicate ?? false }
}, { leaseMs: 2 * 60_000, maxAttempts: 3 })

registerJobHandler('email.reconcile', async () => {
  const r = await reconcileOpen({ actor: 'system:jobs' })
  return { checked: r.length }
}, { maxAttempts: 2, agentWork: false })

registerJobHandler('engine.recover', async () => {
  const r = await recoverInterruptedExecutions({ actor: 'system:recovery' })
  return { resumed: r.resumed.length, markedUnknown: r.markedUnknown }
}, { maxAttempts: 2, agentWork: false })

/** Queue the work that is due now. Safe to call from overlapping crons: idempotency keys queue each item once. */
export async function enqueueDueWork(opts: { now?: Date; limit?: number } = {}) {
  const now = opts.now ?? new Date()
  const { agents, messages } = await admin(async db => ({
    agents: await db.query<{ id: string; org_id: string; next_run_at: string }>(
      `select a.id, a.org_id, a.next_run_at from agents a join store_connections c on c.id = a.connection_id
       where a.status = 'active' and a.next_run_at is not null and a.next_run_at <= $1 and c.status = 'active' order by a.next_run_at limit $2`, [now.toISOString(), opts.limit ?? 200]),
    messages: await db.query<{ id: string; org_id: string; agent_id: string | null; attempts: number }>(
      `select id, org_id, agent_id, attempts from email_messages where status = 'queued' and (next_attempt_at is null or next_attempt_at <= $1) order by created_at limit $2`, [now.toISOString(), opts.limit ?? 200]),
  }))
  const out: { agentRuns: EnqueueResult[]; sends: EnqueueResult[]; maintenance: EnqueueResult[] } = { agentRuns: [], sends: [], maintenance: [] }
  for (const a of agents) out.agentRuns.push(await enqueue({ kind: 'agent.run', orgId: a.org_id, agentId: a.id, payload: { agentId: a.id, orgId: a.org_id, trigger: 'schedule' }, idempotencyKey: `${a.id}@${new Date(a.next_run_at).toISOString()}` }))
  // maintenance runs once per ten-minute window; a send is queued at most once per attempt and window
  // (a message held by the daily cap or a provider wait is queued again in a later window)
  const slot = new Date(Math.floor(now.getTime() / 600e3) * 600e3).toISOString()
  for (const m of messages) out.sends.push(await enqueue({ kind: 'email.send', orgId: m.org_id, agentId: m.agent_id, payload: { messageId: m.id }, idempotencyKey: `${m.id}#${m.attempts}@${slot}` }))
  out.maintenance.push(await enqueue({ kind: 'email.reconcile', idempotencyKey: slot }))
  out.maintenance.push(await enqueue({ kind: 'engine.recover', idempotencyKey: slot }))
  // Resolution Engine: due case checks (lib/cases/jobs.ts registers the handler)
  const { enqueueDueCases } = await import('../cases/jobs')
  out.maintenance.push(...(await enqueueDueCases(now, opts.limit ?? 200)))
  return out
}
