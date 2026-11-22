/**
 * Inbound phone webhooks (Twilio's shape: form-encoded POSTs). Behind OFFICE_PHONE_AGENTS=on (else 404).
 *
 *   POST /api/webhooks/phone/voice   a call to the business's Deploi number. With a forward_to phone on the line, the call rings
 *                           that phone first (TwiML <Dial timeout=20 action=this URL>); an unanswered, busy or failed
 *                           dial (DialCallStatus) is a missed call. Without forward_to every call is a missed call.
 *                           A status callback with CallStatus no-answer / busy / failed / canceled counts too.
 *   POST /api/webhooks/phone/sms     a text to the business's number: one `sms.received` event (the agents' input). A text from
 *                           an active crew member's phone is also handed to the crew reply parser ("DONE").
 *
 * Authentication, fail closed:
 *   - TWILIO_AUTH_TOKEN set: X-Twilio-Signature must match (URL = PHONE_WEBHOOK_BASE_URL or NEXT_PUBLIC_APP_URL + path);
 *   - else PHONE_WEBHOOK_SECRET set: X-Deploi-Signature = hex HMAC-SHA256(secret, raw body) (other providers, tests);
 *   - neither: 503, nothing is processed.
 * The business is found by the number called (office_phone_lines.phone_number = To); an unknown number is ignored.
 * Events are deduped by the provider's id (CallSid / MessageSid), so a retried delivery never acts twice.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { admin } from '../db'
import { routeEvent } from '../events'
import { handleCrewReply } from '../notify/crew'
import { normalizePhone } from '../notify/channels'
import { verifyTwilioSignature, twiml } from '../notify/twilio'
import { phoneAgentsOn } from './phone'

type Env = Record<string, string | undefined>
export type HookResult = { status: number; body: string; contentType: 'text/xml' | 'application/json' }
const xmlOk = (inner = ''): HookResult => ({ status: 200, body: `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, contentType: 'text/xml' })
const json = (status: number, o: Record<string, unknown>): HookResult => ({ status, body: JSON.stringify(o), contentType: 'application/json' })
export const MISSED = ['no-answer', 'busy', 'failed', 'canceled']

export function webhookUrl(path: string, env: Env = process.env) {
  const base = (env.PHONE_WEBHOOK_BASE_URL || env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '')
  return `${base}${path}`
}
export const deploiSignature = (secret: string, raw: string) => createHmac('sha256', secret).update(raw, 'utf8').digest('hex')

export function authenticate(path: string, raw: string, params: Record<string, string>, h: { twilio: string | null; deploi: string | null }, env: Env = process.env): 'ok' | 'bad' | 'unconfigured' {
  const token = (env.TWILIO_AUTH_TOKEN ?? '').trim(), secret = (env.PHONE_WEBHOOK_SECRET ?? '').trim()
  if (token) return verifyTwilioSignature(token, webhookUrl(path, env), params, h.twilio) ? 'ok' : 'bad'
  if (secret.length >= 16) {
    if (!h.deploi) return 'bad'
    const want = Buffer.from(deploiSignature(secret, raw)), got = Buffer.from(h.deploi)
    return want.length === got.length && timingSafeEqual(want, got) ? 'ok' : 'bad'
  }
  return 'unconfigured'
}

type Line = { org_id: string; phone_number: string; forward_to: string | null }
const lineFor = (to: string) => admin(db => db.one<Line>('select org_id, phone_number, forward_to from office_phone_lines where phone_number = $1 and active', [to]))

async function prelude(path: string, raw: string, h: { twilio: string | null; deploi: string | null }, env: Env) {
  if (!phoneAgentsOn(env)) return { stop: json(404, { ok: false, error: 'not_found' }) }
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>
  const auth = authenticate(path, raw, params, h, env)
  if (auth === 'unconfigured') return { stop: json(503, { ok: false, error: 'phone webhooks are not set up (TWILIO_AUTH_TOKEN or PHONE_WEBHOOK_SECRET)' }) }
  if (auth === 'bad') return { stop: json(401, { ok: false, error: 'bad_signature' }) }
  return { params }
}

export async function handleVoiceWebhook(raw: string, h: { twilio: string | null; deploi: string | null }, env: Env = process.env): Promise<HookResult> {
  const path = '/api/webhooks/phone/voice'
  const pre = await prelude(path, raw, h, env)
  if ('stop' in pre) return pre.stop!
  const p = pre.params
  const to = normalizePhone(p.To), from = normalizePhone(p.From), sid = (p.CallSid ?? '').slice(0, 120)
  if (!to || !from || !sid) return xmlOk('<Hangup/>')
  const line = await lineFor(to)
  if (!line) return xmlOk('<Hangup/>')
  const dial = (p.DialCallStatus ?? '').toLowerCase(), call = (p.CallStatus ?? '').toLowerCase()
  const missed = async (status: string) => {
    await routeEvent({ source: 'phone', type: 'call.missed', orgId: line.org_id, externalId: `call:${sid}`, occurredAt: new Date().toISOString(), payload: { callId: sid, from, to, status } })
  }
  if (dial) {
    if (MISSED.includes(dial)) { await missed(dial); return xmlOk(twiml("Sorry we missed you. We'll text you right away.").replace(/^<Response>|<\/Response>$/g, '') + '<Hangup/>') }
    return xmlOk('<Hangup/>')
  }
  if (MISSED.includes(call)) { await missed(call); return xmlOk() }
  if (line.forward_to) return xmlOk(`<Dial timeout="20" action="${webhookUrl(path, env)}">${line.forward_to}</Dial>`)
  await missed('missed')
  return xmlOk(twiml("Sorry we can't take your call right now. We'll text you right away.").replace(/^<Response>|<\/Response>$/g, '') + '<Hangup/>')
}

export async function handleSmsWebhook(raw: string, h: { twilio: string | null; deploi: string | null }, env: Env = process.env): Promise<HookResult> {
  const pre = await prelude('/api/webhooks/phone/sms', raw, h, env)
  if ('stop' in pre) return pre.stop!
  const p = pre.params
  const to = normalizePhone(p.To), from = normalizePhone(p.From), sid = (p.MessageSid ?? p.SmsSid ?? '').slice(0, 120), body = String(p.Body ?? '').slice(0, 1600)
  if (!to || !from || !sid || !body.trim()) return xmlOk()
  const line = await lineFor(to)
  if (!line) return xmlOk()
  const crew = await handleCrewReply({ orgId: line.org_id, from, text: body, channel: 'text', messageId: sid })
  if (!crew.ok && crew.reason === 'the sender is not an active crew member') await routeEvent({ source: 'phone', type: 'sms.received', orgId: line.org_id, externalId: `sms:${sid}`, occurredAt: new Date().toISOString(), payload: { messageId: sid, from, to, body } })
  return xmlOk()
}
