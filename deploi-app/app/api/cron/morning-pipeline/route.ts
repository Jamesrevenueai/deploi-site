import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { getSession } from '@/lib/auth'
import { runMorningPipeline } from '@/lib/sales/morning'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const force = url.searchParams.get('force') === '1'
  const auth = req.headers.get('authorization') ?? ''
  const cronOk = env.cronSecret ? auth === `Bearer ${env.cronSecret}` : !env.isProd || force
  let staffForce = false
  if (force) { const s = await getSession(); staffForce = s?.role === 'staff' }
  if (!cronOk && !staffForce) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const r = await runMorningPipeline({ force: staffForce })
  return NextResponse.json({ ok: true, ...r })
}
