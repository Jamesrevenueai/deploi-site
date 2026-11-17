import { NextResponse } from 'next/server'
import { cronAuthorized } from '@/lib/cron-auth'
import { snapshotHealth } from '@/lib/ops/jobs'
import { log } from '@/lib/log'

export const dynamic = 'force-dynamic'

/** Hourly: write the health counts as an operational log row and the cron.health heartbeat. Counts only. CRON_SECRET only. */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  try {
    return NextResponse.json({ ok: true, health: await snapshotHealth() })
  } catch (e) {
    log.error('cron.health.failed', { error: (e as Error).message.slice(0, 200) })
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 })
  }
}
