import { NextResponse } from 'next/server'
import '@/lib/connectors'
import { runDueJobs, recordHeartbeat } from '@/lib/jobs'
import { emitSweep, EVENT_JOB } from '@/lib/events'
import { LOOP_RESUME_JOB } from '@/lib/events/loop'
import { cronAuthorized } from '@/lib/cron-auth'
import { log } from '@/lib/log'
import { flushWorkflowCounters } from '@/lib/ai/meter'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * The 15-minute sweep: one 'sweep' event per active organization (deduplicated per window, so an overlapping
 * call queues nothing twice), then the agents' event jobs and approved actions run until shortly before the time
 * limit. Anything left is picked up by the next sweep or the hourly job worker. CRON_SECRET only.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const sweep = await emitSweep()
    const r = await runDueJobs({ kinds: [EVENT_JOB, LOOP_RESUME_JOB, 'case.check'], deadlineMs: 240_000, limit: 300 })
    await flushWorkflowCounters()
    const counts = r.ran.reduce<Record<string, number>>((acc, o) => { acc[o.status] = (acc[o.status] ?? 0) + 1; return acc }, {})
    await recordHeartbeat('cron.sweep', r.paused ? 'paused' : 'ok', { orgs: sweep.orgs, jobs: sweep.jobs, ran: r.ran.length, ...counts })
    return NextResponse.json({ ok: true, paused: r.paused, sweep, ran: r.ran.length, counts })
  } catch (e) {
    log.error('cron.sweep.failed', { error: (e as Error).message.slice(0, 200) })
    await recordHeartbeat('cron.sweep', 'failed').catch(() => {})
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 })
  }
}
