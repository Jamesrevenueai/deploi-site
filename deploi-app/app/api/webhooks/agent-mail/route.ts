/**
 * Resend email.received webhook for agent mailboxes (AGENT_MAIL_DOMAIN). Fails closed: without
 * AGENT_MAIL_WEBHOOK_SECRET it refuses every delivery (503); with it, only svix-signed deliveries no
 * older than five minutes are accepted. The body carries metadata only; lib/email/inbound.ts fetches
 * the text, threads, classifies, quarantines and audits. Nothing here can send mail or change a permission.
 */
import { NextResponse } from 'next/server'
import { log } from '@/lib/log'
import { emailConfig } from '@/lib/email/config'
import { inboundConfigured, processInbound } from '@/lib/email/inbound'
import { verifySvix } from '@/lib/workers/webhooks'

export const dynamic = 'force-dynamic'
const TOLERANCE_SEC = 300

export async function POST(req: Request) {
  if (!inboundConfigured()) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 })
  const raw = await req.text()
  const id = req.headers.get('svix-id'), ts = req.headers.get('svix-timestamp')
  const age = Math.abs(Date.now() / 1000 - Number(ts))
  if (!Number.isFinite(age) || age > TOLERANCE_SEC || !verifySvix(emailConfig.agentMailWebhookSecret, id, ts, req.headers.get('svix-signature'), raw)) {
    log.warn('agent_mail.webhook.rejected', { reason: !Number.isFinite(age) || age > TOLERANCE_SEC ? 'timestamp' : 'signature' })
    return NextResponse.json({ ok: false }, { status: 403 })
  }
  let evt: { type?: string; data?: Record<string, unknown> }
  try { evt = JSON.parse(raw) } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }) }
  try {
    const r = await processInbound({ deliveryId: id!, type: String(evt.type ?? ''), data: evt.data ?? {} })
    return NextResponse.json({ ok: true, outcome: r.outcome })
  } catch (e) {
    // 500 makes the provider retry; the delivery row is not marked handled for a failed fetch
    log.error('agent_mail.webhook.failed', { error: (e as Error).message.slice(0, 200) })
    return NextResponse.json({ ok: false, error: 'processing_failed' }, { status: 500 })
  }
}
