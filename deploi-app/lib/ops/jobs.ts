/**
 * Operations job kinds (registered on the durable queue when this module is imported):
 *
 *   ops.alerts   evaluate every alert rule (lib/ops/alerts.ts), then prune old operational logs; queued once per
 *                ten-minute window by /api/cron/alerts and by every /api/cron/jobs sweep (same idempotency key,
 *                so overlapping crons queue it once). Maintenance: carries no organization, agentWork false.
 *   health snapshot (snapshotHealth): the counts /api/health shows, written as one ops log row and the
 *                `cron.health` heartbeat (/api/cron/health, hourly), so a quiet platform still leaves a trail.
 */
import { admin } from '../db'
import { enqueue, queueStats, registerJobHandler, type EnqueueResult } from '../jobs/queue'
import { recordHeartbeat } from '../jobs/heartbeat'
import { aiGatewayStatus } from '../ai/gateway'
import { platformLag } from '../platform/health'
import { evaluateAlerts } from './alerts'
import { pruneOpsLogs, writeOpsLog } from './logs'

export const slotOf = (now: Date) => new Date(Math.floor(now.getTime() / 600e3) * 600e3).toISOString()

registerJobHandler('ops.alerts', async () => {
  const r = await evaluateAlerts()
  const pruned = await pruneOpsLogs()
  await recordHeartbeat('ops.alerts', Object.keys(r.errors).length ? 'failed' : 'ok', { opened: r.opened.length, resolved: r.resolved.length, live_updated: r.updated.length, rule_errors: Object.keys(r.errors).length, logs_pruned: pruned })
  return { opened: r.opened.length, updated: r.updated.length, resolved: r.resolved.length, ruleErrors: Object.keys(r.errors) }
}, { maxAttempts: 2, agentWork: false, leaseMs: 5 * 60_000 })

export async function enqueueOpsWork(now = new Date()): Promise<EnqueueResult[]> {
  return [await enqueue({ kind: 'ops.alerts', idempotencyKey: `alerts@${slotOf(now)}` })]
}

/** Health counts (no tenant data) as an ops log row and the cron.health heartbeat. */
export async function snapshotHealth(now = new Date()) {
  const s = await admin(async db => ({ queue: await queueStats(db, now), ai: await aiGatewayStatus(db, now), platform: await platformLag(db, now) }))
  const detail = {
    queue_due: s.queue.due, queue_running: s.queue.running, queue_dead: s.queue.dead, expired_leases: s.queue.expiredLeases, oldest_due_age_sec: s.queue.oldestDueAgeSec,
    ai_provider: s.ai.provider, ai_calls_hour: s.ai.lastHour.calls, ai_errors_hour: s.ai.lastHour.providerErrors, ai_stale_pending: s.ai.stalePending,
    retention_lag_hours: s.platform.retention.lagHours, deletions_overdue: s.platform.deletion.overdue, deletions_failed: s.platform.deletion.failed,
  }
  await writeOpsLog({ level: s.queue.dead || s.platform.deletion.failed ? 'warn' : 'info', event: 'health.snapshot', summary: `queue due ${s.queue.due}, dead ${s.queue.dead}, oldest ${s.queue.oldestDueAgeSec}s`, detail })
  await recordHeartbeat('cron.health', 'ok', { dead: s.queue.dead, due: s.queue.due })
  return detail
}
