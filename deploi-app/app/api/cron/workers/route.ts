/**
 * Nightly workers (vercel.json: 06:00 UTC). Also callable by staff for one worker:
 *   GET /api/cron/workers?worker=open_shift_fill&agency=<id>&force=1
 * Bearer CRON_SECRET is required whenever it is set.
 */
import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { getSession } from '@/lib/auth'
import '@/workers'
import { runAllNightly, runWorker } from '@/lib/workers/runtime'
import { WORKER_NAMES, type WorkerName } from '@/lib/workers/types'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const auth = req.headers.get('authorization')
  const session = await getSession().catch(() => null)
  const isCron = env.cronSecret ? auth === `Bearer ${env.cronSecret}` : !env.isProd || Boolean(session && session.role === 'staff')
  if (!isCron && !(session && session.role === 'staff')) return NextResponse.json({ ok: false }, { status: 401 })
  const url = new URL(req.url)
  const worker = url.searchParams.get('worker') as WorkerName | null
  const agency = url.searchParams.get('agency')
  const dryRun = url.searchParams.get('dry_run') === '1'
  const agencies = agency ? [agency] : (await admin(db => db.query<{ id: string }>('select id from agencies'))).map(a => a.id)
  const results = []
  for (const a of agencies) {
    if (worker) {
      if (!WORKER_NAMES.includes(worker)) return NextResponse.json({ ok: false, error: 'unknown worker' }, { status: 400 })
      results.push(await runWorker(worker, a, { dryRun }))
    } else results.push(...(await runAllNightly(a, { dryRun })))
  }
  return NextResponse.json({ ok: true, runs: results })
}
