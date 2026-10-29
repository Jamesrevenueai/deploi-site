/**
 * Hourly cron (vercel.json). Sends each agency's morning report once, at 07:00 agency-local time.
 * Auth: Vercel sends Authorization: Bearer ${CRON_SECRET}. A signed-in staff user may force a send
 * with ?force=1&agency=<id> (used by the preview page).
 * Idempotency: withJobLock('cron:morning_report:<agency>', agency-local date) — a duplicate cron run in the
 * same local day is skipped before anything is built or sent (the worker_runs check remains as a second guard).
 * Being hourly, this route also drains queued (contact-window) actions that have become due.
 */
import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { log } from '@/lib/log'
import { withJobLock } from '@/lib/jobs/lock'
import { shouldSendNow } from '@/lib/dashboard/schedule'
import { localDayStart } from '@/lib/dashboard/time'
import { sendMorningReport } from '@/lib/dashboard/send'
import { localDateKey } from '@/lib/workers/window'
import { drainDueActions, markUnknownDeliveries } from '@/lib/workers/runtime'
import { cronAuthorized } from '@/lib/cron-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const force = url.searchParams.get('force') === '1'
  const only = url.searchParams.get('agency')
  const cronOk = cronAuthorized(req)
  let staffOk = false
  if (force) { const s = await getSession(); staffOk = s?.role === 'staff' }
  if (!cronOk && !staffOk) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  if (force && !staffOk) return NextResponse.json({ ok: false, error: 'force requires staff' }, { status: 403 })

  const now = new Date()
  const out = await admin(async db => {
    const agencies = await db.query<{ id: string; name: string; timezone: string }>(
      `select g.id, g.name, g.timezone from agencies g
       where exists (select 1 from profiles p where p.agency_id = g.id and p.role = 'client') ${only ? 'and g.id = $1' : ''} order by g.name`, only ? [only] : [])
    const results: { agency: string; sent: boolean; reason?: string; recipients?: number }[] = []
    for (const g of agencies) {
      const tz = g.timezone || 'America/New_York'
      const already = await db.one<{ n: string }>(
        "select count(*) as n from worker_runs where worker = 'morning_report' and agency_id = $1 and started_at >= $2", [g.id, localDayStart(tz, now)])
      const alreadySent = Number(already?.n ?? 0) > 0
      if (!force && !shouldSendNow(tz, now, alreadySent)) { results.push({ agency: g.id, sent: false, reason: alreadySent ? 'already sent today' : 'not 07:00 local' }); continue }
      if (force) { const r = await sendMorningReport(db, g.id, now, { force: true }); results.push({ agency: g.id, sent: true, recipients: r.recipients }); continue }
      const locked = await withJobLock(db, `cron:morning_report:${g.id}`, localDateKey(now, tz), () => sendMorningReport(db, g.id, now))
      if (locked.skipped) results.push({ agency: g.id, sent: false, reason: 'already ran today (job lock)' })
      else if (locked.error) results.push({ agency: g.id, sent: false, reason: locked.error })
      else results.push({ agency: g.id, sent: true, recipients: locked.result?.recipients })
    }
    return results
  })
  const drained = await admin(async db => ({ ...(await drainDueActions(db, now)), unknown: await markUnknownDeliveries(db, now) }))
  log.info('cron.morning_report', { agencies: out.length, sent: out.filter(r => r.sent).length, ...drained })
  return NextResponse.json({ ok: true, at: now.toISOString(), results: out, drained })
}
