/**
 * Connection-health monitoring: the `connection.health` job (durable queue, maintenance, no organization).
 * The hourly cron (/api/cron/jobs) queues one per UTC hour; the job probes every monitored connection whose
 * next probe is due (lib/integrations/check.ts: timeout, history, backoff, status flips) and prunes history
 * older than 90 days. Probes run one at a time and stop before the job's deadline; whatever is left is due
 * on the next run. Operations alerting reads the transitions it writes (connection_health rows whose
 * previous_status and status differ).
 */
import { admin } from '../db'
import { enqueue, registerJobHandler, type EnqueueResult } from '../jobs/queue'
import { INTEGRATIONS } from './registry'
import { probeAndRecord, healthConfig } from './check'
import type { HealthStateRow } from './events'
import type { ConnRef } from './probes'
import type { IntegrationKey } from './types'

export const HISTORY_DAYS = 90

export type HealthRunResult = { probed: number; ok: number; failed: number; transitions: number; skippedNotDue: number; pruned: number }

/** Probe every monitored connection that is due. `orgIds` limits the run (tests); `keys` limits the integrations. */
export async function runHealthChecks(opts: { now?: Date; orgIds?: string[]; keys?: IntegrationKey[]; limit?: number; deadline?: number; timeoutMs?: number } = {}): Promise<HealthRunResult> {
  const now = opts.now ?? new Date()
  const limit = opts.limit ?? 200
  const out: HealthRunResult = { probed: 0, ok: 0, failed: 0, transitions: 0, skippedNotDue: 0, pruned: 0 }
  const due: ConnRef[] = []
  await admin(async db => {
    const deleted = new Set((await db.query<{ id: string }>('select id from agencies where deleted_at is not null')).map(r => r.id))
    for (const def of INTEGRATIONS.filter(d => d.monitored && (!opts.keys || opts.keys.includes(d.key)))) {
      const conns = (await def.connections(db, null)).filter(c => !deleted.has(c.orgId) && (!opts.orgIds || opts.orgIds.includes(c.orgId)))
      if (!conns.length) continue
      const states = await db.query<HealthStateRow>(`select * from connection_health_state where integration = $1 and connection_id = any($2::uuid[])`, [def.key, conns.map(c => c.id)])
      for (const c of conns) {
        const s = states.find(x => x.connection_id === c.id)
        if (s && new Date(s.next_probe_at).getTime() > now.getTime()) out.skippedNotDue++
        else due.push(c)
      }
    }
  })
  for (const c of due.slice(0, limit)) {
    if (opts.deadline && Date.now() > opts.deadline - 30_000) break
    const r = await probeAndRecord(c, 'schedule', { now, timeoutMs: opts.timeoutMs ?? healthConfig.timeoutMs })
    out.probed++
    if (r.ok) out.ok++; else out.failed++
    if (r.previous !== r.status) out.transitions++
  }
  out.pruned = (await admin(db => db.query(`delete from connection_health where checked_at < $1 returning id`, [new Date(now.getTime() - HISTORY_DAYS * 864e5).toISOString()]))).length
  return out
}

registerJobHandler('connection.health', async (_payload, ctx) => ({ ...(await runHealthChecks({ deadline: ctx.deadline })) }), { agentWork: false, maxAttempts: 2, leaseMs: 10 * 60_000 })

/** Queue the hourly health run (one per UTC hour, whatever the number of cron calls). */
export function enqueueHealthWork(now = new Date()): Promise<EnqueueResult> {
  return enqueue({ kind: 'connection.health', idempotencyKey: `health@${now.toISOString().slice(0, 13)}` })
}
