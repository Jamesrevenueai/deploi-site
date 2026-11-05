/**
 * Stripe webhook endpoint. Refused unless billing is on and STRIPE_WEBHOOK_SECRET is set; every delivery
 * must carry a valid `Stripe-Signature` over the exact raw body (5-minute tolerance, constant-time,
 * any of several v1 signatures). Events are deduplicated by id (lib/billing/webhooks.ts). A test-mode
 * environment refuses live events and the other way round.
 */
import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { log } from '@/lib/log'
import { billingMode, stripeConfig } from '@/lib/billing/config'
import { verifyStripeSignature } from '@/lib/billing/stripe'
import { handleStripeEvent, isStripeEvent } from '@/lib/billing/webhooks'
import { deliverNotices } from '@/lib/billing/notify'
import { limitRejectedWebhook } from '@/lib/security/rate-limit'

export const dynamic = 'force-dynamic'

const MAX_BYTES = 1_000_000

export async function POST(req: Request) {
  const mode = billingMode()
  if (mode === 'off' || !stripeConfig.webhookSecret) return NextResponse.json({ ok: false, error: 'billing_off' }, { status: 503 })
  const raw = await req.text()
  if (raw.length > MAX_BYTES) return NextResponse.json({ ok: false, error: 'too_large' }, { status: 413 })
  const sig = verifyStripeSignature(raw, req.headers.get('stripe-signature'), stripeConfig.webhookSecret)
  if (!sig.ok) {
    log.warn('stripe.webhook.bad_signature', { reason: sig.reason })
    // only rejected deliveries are counted (per IP); a valid one is never limited
    return limitRejectedWebhook(req, NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 400 }), true)
  }
  let event: unknown
  try { event = JSON.parse(raw) } catch { return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 }) }
  if (!isStripeEvent(event)) return NextResponse.json({ ok: false, error: 'invalid_event' }, { status: 400 })
  if (event.livemode !== (mode === 'live')) {
    log.warn('stripe.webhook.wrong_mode', { type: event.type, livemode: event.livemode })
    return NextResponse.json({ ok: true, ignored: 'livemode does not match BILLING_MODE' })
  }
  try {
    const r = await admin(db => handleStripeEvent(db, event))
    // notices queued by the event are sent now that it is committed; a send failure is retried by the cron
    if (r.orgId) await deliverNotices({ orgId: r.orgId }).catch(e => log.warn('stripe.webhook.notice_failed', { error: (e as Error).message.slice(0, 200) }))
    return NextResponse.json({ ok: true, duplicate: r.duplicate, outcome: r.outcome ?? null })
  } catch (e) {
    // rolled back: the event id was not claimed, so Stripe's retry processes it again
    log.error('stripe.webhook.failed', { type: event.type, error: (e as Error).message.slice(0, 200) })
    return NextResponse.json({ ok: false, error: 'processing_failed' }, { status: 500 })
  }
}
