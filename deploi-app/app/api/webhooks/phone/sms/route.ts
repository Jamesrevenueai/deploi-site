/** Inbound sms webhook for the Office phone agents (lib/packs/phone-webhook.ts). 404 unless OFFICE_PHONE_AGENTS=on. */
import { NextResponse } from 'next/server'
import { log } from '@/lib/log'
import { handleSmsWebhook } from '@/lib/packs/phone-webhook'
import '@/lib/packs'
import { limitRejectedWebhook } from '@/lib/security/rate-limit'

export const dynamic = 'force-dynamic'
const MAX_BYTES = 64 * 1024

export async function POST(req: Request) {
  const raw = await req.text()
  if (raw.length > MAX_BYTES) return NextResponse.json({ ok: false, error: 'too_large' }, { status: 413 })
  try {
    const r = await handleSmsWebhook(raw, { twilio: req.headers.get('x-twilio-signature'), deploi: req.headers.get('x-deploi-signature') })
    const res = new NextResponse(r.body, { status: r.status, headers: { 'content-type': r.contentType } })
    if (r.status === 401) { log.warn('phone.sms.webhook_rejected', { reason: 'signature' }); return limitRejectedWebhook(req, res) }
    return res
  } catch (e) {
    log.error('phone.sms.webhook_failed', { error: (e as Error).message.slice(0, 200) })
    return NextResponse.json({ ok: false, error: 'processing_failed' }, { status: 500 })
  }
}
