import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { queueStats } from '@/lib/jobs/queue'
import { heartbeats } from '@/lib/jobs/heartbeat'
import { log } from '@/lib/log'
import { aiGatewayStatus } from '@/lib/ai/gateway'
import { platformLag } from '@/lib/platform/health'

export const dynamic = 'force-dynamic'

/**
 * Liveness and queue health. Counts, ages and times only: no organization, agent, address or job
 * payload is ever returned. `ok` is false when the database cannot be reached. Also: the AI gateway
 * (on/off, configured, last hour's calls, provider errors and refusals) and the lag of the retention and
 * deletion jobs (docs/MONITORING.md has the alert thresholds).
 */
export async function GET() {
  const base = { auth: env.authMode, email: env.resendKey ? 'resend' : 'mock' }
  try {
    const started = Date.now()
    const r = await admin(async db => {
      await db.query('select 1')
      const latencyMs = Date.now() - started
      return { latencyMs, queue: await queueStats(db), crons: await heartbeats(db), ai: await aiGatewayStatus(db), platform: await platformLag(db) }
    })
    return NextResponse.json({
      ok: true, ...base,
      db: { reachable: true, latencyMs: r.latencyMs },
      queue: { depth: r.queue.queued, due: r.queue.due, running: r.queue.running, dead: r.queue.dead, expiredLeases: r.queue.expiredLeases, oldestDueAgeSec: r.queue.oldestDueAgeSec },
      crons: Object.fromEntries(r.crons.map(c => [c.job_key, { lastRunAt: new Date(c.last_run_at).toISOString(), status: c.last_status }])),
      ai: r.ai,
      retention: r.platform.retention,
      deletion: r.platform.deletion,
      paused: { jobs: (process.env.JOBS_PAUSED ?? '').trim() === 'on', liveWrites: (process.env.LIVE_WRITES ?? '').trim() === 'off' },
    })
  } catch (e) {
    log.error('health.db_unreachable', { error: (e as Error).message.slice(0, 120) })
    return NextResponse.json({ ok: false, ...base, db: { reachable: false } }, { status: 503 })
  }
}
