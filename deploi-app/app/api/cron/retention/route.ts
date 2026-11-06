import { NextResponse } from 'next/server'
import { cronAuthorized } from '@/lib/cron-auth'
import { runDueJobs } from '@/lib/jobs'
import { enqueuePlatformWork } from '@/lib/platform/jobs'
import { log } from '@/lib/log'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Daily: queue the retention pass (platform.retention, once per UTC day) and any organization deletion whose
 * cooling-off ended, then run them. The hourly job worker would also pick them up; this cron makes the daily
 * pass independent of it. CRON_SECRET only.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    await enqueuePlatformWork()
    const r = await runDueJobs({ kinds: ['platform.retention', 'platform.deletion'], limit: 5, deadlineMs: 240_000 })
    return NextResponse.json({ ok: true, paused: r.paused, ran: r.ran.map(o => ({ kind: o.kind, status: o.status })) })
  } catch (e) {
    log.error('cron.retention.failed', { error: (e as Error).message.slice(0, 200) })
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 })
  }
}
