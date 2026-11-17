import { NextResponse } from 'next/server'
import '@/lib/connectors'
import { enqueueDueWork, recordHeartbeat, runDueJobs } from '@/lib/jobs'
import { cronAuthorized } from '@/lib/cron-auth'
import { log } from '@/lib/log'
import { flushWorkflowCounters } from '@/lib/ai/meter'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * The job queue worker: queues what is due (agent runs, sends, recovery), then runs due jobs until
 * shortly before the function's time limit. Jobs left over, or interrupted by a timeout, are claimed
 * again by the next call once their lease expires. CRON_SECRET only.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const queued = await enqueueDueWork()
    const r = await runDueJobs({ deadlineMs: 240_000, limit: 200 })
    await flushWorkflowCounters()
    const counts = r.ran.reduce<Record<string, number>>((acc, o) => { acc[o.status] = (acc[o.status] ?? 0) + 1; return acc }, {})
    await recordHeartbeat('cron.jobs', r.paused ? 'paused' : 'ok', { ran: r.ran.length, ...counts })
    return NextResponse.json({ ok: true, paused: r.paused, queued: { agentRuns: queued.agentRuns.filter(q => q.created).length, sends: queued.sends.filter(q => q.created).length }, ran: r.ran.length, counts })
  } catch (e) {
    log.error('cron.jobs.failed', { error: (e as Error).message.slice(0, 200) })
    await recordHeartbeat('cron.jobs', 'failed').catch(() => {})
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 })
  }
}
