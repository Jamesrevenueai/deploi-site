import { NextResponse } from 'next/server'
import { cronAuthorized } from '@/lib/cron-auth'
import { runDueJobs } from '@/lib/jobs'
import { enqueueMorningReports } from '@/lib/notify/morning'
import { recordHeartbeat } from '@/lib/jobs/heartbeat'
import { log } from '@/lib/log'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Daily (vercel.json "11 12 * * *" UTC): queue one morning report per business organization (job
 * notify.morning, once per organization per day) and run them. Reports not finished before the deadline are
 * picked up by the hourly job worker; a repeat for the same day sends nothing. CRON_SECRET only.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    const queued = await enqueueMorningReports()
    const r = await runDueJobs({ kinds: ['notify.morning'], limit: 200, deadlineMs: 240_000 })
    await recordHeartbeat('cron.daily-report', 'ok', { queued: queued.length, ran: r.ran.length })
    return NextResponse.json({ ok: true, paused: r.paused, queued: queued.length, ran: r.ran.map(o => ({ kind: o.kind, status: o.status })) })
  } catch (e) {
    log.error('cron.daily_report.failed', { error: (e as Error).message.slice(0, 200) })
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 })
  }
}
