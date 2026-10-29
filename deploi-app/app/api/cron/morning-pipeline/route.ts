import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getSession } from '@/lib/auth'
import { runMorningPipeline } from '@/lib/sales/morning'
import { cronAuthorized } from '@/lib/cron-auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const force = url.searchParams.get('force') === '1'
  const cronOk = cronAuthorized(req)
  let staffForce = false
  if (force) { const s = await getSession(); staffForce = s?.role === 'staff' }
  if (!cronOk && !staffForce) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const r = await runMorningPipeline({ force: staffForce })
  return NextResponse.json({ ok: true, ...r })
}
