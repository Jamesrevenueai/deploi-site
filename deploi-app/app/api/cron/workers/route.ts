/**
 * Nightly workers (vercel.json: 06:00 UTC). Also callable by staff for one worker:
 *   GET /api/cron/workers?worker=open_shift_fill&agency=<id>&force=1
 * Bearer CRON_SECRET is required whenever it is set.
 * Idempotent per agency per agency-local day through withJobLock: a duplicate cron run is skipped and can
 * never produce duplicate proposals or sends. A staff ?force=1 run bypasses the lock (runWorker still dedupes
 * by dedupe_key). Every run also drains queued (contact-window) actions that are due and ages out
 * provider-accepted sends with no delivery callback.
 */
import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { log } from '@/lib/log'
import { withJobLock } from '@/lib/jobs/lock'
import '@/workers'
import { runAllNightly, runWorker, drainDueActions, markUnknownDeliveries, type RunSummary } from '@/lib/workers/runtime'
import { localDateKey } from '@/lib/workers/window'
import { WORKER_NAMES, type WorkerName } from '@/lib/workers/types'
import { cronAuthorized } from '@/lib/cron-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const session = await getSession().catch(() => null)
  const isStaff = Boolean(session && session.role === 'staff')
  const isCron = cronAuthorized(req) || isStaff
  if (!isCron && !isStaff) return NextResponse.json({ ok: false }, { status: 401 })
  const url = new URL(req.url)
  const worker = url.searchParams.get('worker') as WorkerName | null
  const agency = url.searchParams.get('agency')
  const dryRun = url.searchParams.get('dry_run') === '1'
  const force = url.searchParams.get('force') === '1' && isStaff
  if (worker && !WORKER_NAMES.includes(worker)) return NextResponse.json({ ok: false, error: 'unknown worker' }, { status: 400 })
  const now = new Date()
  const agencies = await admin(db => db.query<{ id: string; timezone: string }>(`select id, timezone from agencies ${agency ? 'where id = $1' : ''} order by name`, agency ? [agency] : []))
  const results: { agency: string; skipped?: boolean; runs?: RunSummary[]; error?: string }[] = []
  for (const a of agencies) {
    const period = localDateKey(now, a.timezone || 'America/New_York')
    const key = `cron:workers:${worker ?? 'nightly'}:${a.id}`
    const run = async () => worker ? [await runWorker(worker, a.id, { dryRun, now })] : runAllNightly(a.id, { dryRun, now })
    if (force) { results.push({ agency: a.id, runs: await run() }); continue }
    const out = await admin(db => withJobLock(db, key, period, run))
    if (out.skipped) results.push({ agency: a.id, skipped: true })
    else if (out.error) results.push({ agency: a.id, error: out.error })
    else results.push({ agency: a.id, runs: out.result })
  }
  const drained = await admin(async db => ({ ...(await drainDueActions(db, now)), unknown: await markUnknownDeliveries(db, now) }))
  log.info('cron.workers', { agencies: agencies.length, skipped: results.filter(r => r.skipped).length, ...drained })
  return NextResponse.json({ ok: true, at: now.toISOString(), results, drained })
}
