import { NextResponse } from 'next/server'
import { cronAuthorized } from '@/lib/cron-auth'
import { recordHeartbeat, runDueJobs } from '@/lib/jobs'
import { enqueueOpsWork } from '@/lib/ops/jobs'
import { log } from '@/lib/log'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * Every 10 minutes: queue the alert evaluation (ops.alerts, once per ten-minute window whatever overlaps) and run
 * it. Alerts are deduplicated per rule and subject and resolve themselves when the condition clears
 * (lib/ops/alerts.ts). CRON_SECRET only. While JOBS_PAUSED=on nothing runs (the uptime check on /api/health is
 * the independent signal).
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    await enqueueOpsWork()
    const r = await runDueJobs({ kinds: ['ops.alerts'], limit: 3, deadlineMs: 90_000 })
    await recordHeartbeat('cron.alerts', r.paused ? 'paused' : 'ok', { ran: r.ran.length })
    return NextResponse.json({ ok: true, paused: r.paused, ran: r.ran.map(o => ({ status: o.status, result: o.result ?? null })) })
  } catch (e) {
    log.error('cron.alerts.failed', { error: (e as Error).message.slice(0, 200) })
    await recordHeartbeat('cron.alerts', 'failed').catch(() => {})
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 })
  }
}
