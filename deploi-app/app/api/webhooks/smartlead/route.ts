import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { log } from '@/lib/log'
import { handleSmartleadEvent, type SmartleadPayload } from '@/lib/sales/smartlead'
import { webhookSecretGuard, guardResponse } from '@/lib/workers/webhook-guard'
import { opsConfig } from '@/lib/workers/config'

function secretOk(req: Request, body: SmartleadPayload) {
  const want = env.smartleadSecret
  if (!want) return true // outside production only; production without a secret is refused above with 503
  const got = req.headers.get('x-smartlead-secret') ?? body.secret_key ?? ''
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want))
}

export async function POST(req: Request) {
  const refused = guardResponse('smartlead', webhookSecretGuard('smartlead', env.smartleadSecret, opsConfig.isProd))
  if (refused) return refused
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
