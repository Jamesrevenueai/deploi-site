/**
 * Twilio message status callback (StatusCallback on the outbound message). MessageStatus delivered /
 * failed / undelivered -> delivery_status on the proposed action with that MessageSid.
 * Same authentication rule as the inbound route: 503 in production without the auth token, verified when set.
 */
import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { log } from '@/lib/log'
import { verifyTwilio } from '@/lib/workers/webhooks'
import { webhookSecretGuard, guardResponse } from '@/lib/workers/webhook-guard'
import { opsConfig } from '@/lib/workers/config'
import { recordDeliveryCallback, type DeliveryOutcome } from '@/lib/workers/runtime'

const OUTCOMES: Record<string, DeliveryOutcome> = { delivered: 'delivered', failed: 'failed', undelivered: 'undelivered' }

export async function POST(req: Request) {
  const refused = guardResponse('twilio-status', webhookSecretGuard('twilio-status', env.twilio.token, opsConfig.isProd))
  if (refused) return refused
  const raw = await req.text()
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>
  if (env.twilio.token) {
    const url = `${env.appUrl}/api/webhooks/twilio/status`
    if (!verifyTwilio(env.twilio.token, url, params, req.headers.get('x-twilio-signature'))) {
      log.warn('twilio.status.signature.invalid', {})
      return NextResponse.json({ ok: false }, { status: 403 })
    }
  }
  const sid = (params.MessageSid ?? params.SmsSid ?? '').trim()
  const status = (params.MessageStatus ?? params.SmsStatus ?? '').trim().toLowerCase()
  const outcome = OUTCOMES[status]
  if (!sid || !outcome) return NextResponse.json({ ok: true, ignored: status || 'no status' })
  const reason = outcome === 'delivered' ? null : [params.ErrorCode, params.ErrorMessage].filter(Boolean).join(' ') || outcome
  const matched = await admin(db => recordDeliveryCallback(db, sid, outcome, reason))
  return NextResponse.json({ ok: true, matched, status })
}
