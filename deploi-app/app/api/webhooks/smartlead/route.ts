import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { log } from '@/lib/log'
import { handleSmartleadEvent, type SmartleadPayload } from '@/lib/sales/smartlead'

function secretOk(req: Request, body: SmartleadPayload) {
  const want = env.smartleadSecret
  if (!want) { log.warn('smartlead.webhook.unsigned', {}); return true }
  const got = req.headers.get('x-smartlead-secret') ?? body.secret_key ?? ''
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want))
}

export async function POST(req: Request) {
  let body: SmartleadPayload
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }) }
  if (!secretOk(req, body)) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  try {
    const r = await admin(db => handleSmartleadEvent(db, body), { ip })
    log.info('smartlead.webhook', { event: body.event_type, handled: r.handled, created: r.created, stage: r.stage })
    return NextResponse.json({ ok: true, ...r })
  } catch (e) {
    log.error('smartlead.webhook.failed', { error: (e as Error).message })
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 })
  }
}
