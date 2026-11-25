/**
 * Live text and voice through Twilio (NOTIFY_SMS_PROVIDER=twilio). Built so it can go live with only Vercel
 * settings, and so that nothing reaches a real person by mistake:
 *
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN      the account (the token also verifies Twilio's webhooks)
 *   TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID   who the text comes from (voice needs TWILIO_FROM_NUMBER)
 *   NOTIFY_LIVE_SENDS=on                       without it every message is recorded as "held" and nothing leaves
 *   NOTIFY_ALLOWED_NUMBERS=+1555...,+1555...   when set, ONLY these numbers can receive anything (test mode);
 *                                              every other number is held with the reason
 *
 * The record (notify_outbox) is written first and is idempotent per (organization, dedupe key, channel): a repeat
 * returns the first record and never sends twice. A provider refusal is recorded as "failed" with Twilio's reason.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Db } from '../db'
import { recordAction } from '../metering'
import { clipText, voiceTranscript, type ChannelAdapter, type ChannelMessage, type ChannelResult } from './channels'

type Env = Record<string, string | undefined>
export type TwilioConfig = { accountSid: string; authToken: string; from: string | null; messagingServiceSid: string | null; live: boolean; allowed: string[] | null }

export function twilioConfig(env: Env = process.env): TwilioConfig | null {
  const accountSid = (env.TWILIO_ACCOUNT_SID ?? '').trim(), authToken = (env.TWILIO_AUTH_TOKEN ?? '').trim()
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid) || authToken.length < 16) return null
  const allowed = (env.NOTIFY_ALLOWED_NUMBERS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return {
    accountSid, authToken,
    from: (env.TWILIO_FROM_NUMBER ?? '').trim() || null,
    messagingServiceSid: (env.TWILIO_MESSAGING_SERVICE_SID ?? '').trim() || null,
    live: (env.NOTIFY_LIVE_SENDS ?? '').trim().toLowerCase() === 'on',
    allowed: allowed.length ? allowed : null,
  }
}

/** Why a message must not leave, or null when it may. */
export function holdReason(c: TwilioConfig | null, to: string, channel: 'text' | 'voice'): string | null {
  if (!c) return 'Twilio is not set up (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN); nothing was sent'
  if (!c.live) return 'live sends are off (NOTIFY_LIVE_SENDS is not on); nothing was sent'
  if (c.allowed && !c.allowed.includes(to)) return 'test mode: this number is not in NOTIFY_ALLOWED_NUMBERS; nothing was sent'
  if (channel === 'voice' && !c.from) return 'voice needs TWILIO_FROM_NUMBER; nothing was sent'
  if (channel === 'text' && !c.from && !c.messagingServiceSid) return 'texts need TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID; nothing was sent'
  return null
}

const xml = (s: string) => s.replace(/[<>&'"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]!))
export const twiml = (spoken: string) => `<Response><Say voice="Polly.Joanna">${xml(spoken)}</Say></Response>`

type Fetch = typeof fetch
type Row = { id: string; status: ChannelResult['status']; status_reason: string | null; transcript: string | null; provider_message_id: string | null }

export function twilioAdapter(env: Env = process.env, http: Fetch = fetch): ChannelAdapter {
  const c = twilioConfig(env)
  async function deliver(db: Db, m: ChannelMessage, channel: 'text' | 'voice'): Promise<ChannelResult> {
    const body = channel === 'text' ? clipText(m.body) : m.body
    const transcript = channel === 'voice' ? voiceTranscript(m.body) : null
    const hold = holdReason(c, m.toPhone, channel)
    const ins = await db.one<Row>(
      `insert into notify_outbox (org_id, audience, recipient_ref, to_phone, channel, provider, dedupe_key, body, transcript, status, status_reason)
       values ($1,$2,$3,$4,$5,'twilio',$6,$7,$8,$9,$10) on conflict (org_id, dedupe_key, channel) do nothing returning id, status, status_reason, transcript, provider_message_id`,
      [m.orgId, m.audience, m.recipientRef, m.toPhone, channel, m.dedupeKey.slice(0, 200), clipText(body, 4000), transcript, hold ? 'held' : 'failed', hold ?? 'sending']) // 'failed' until Twilio accepts it
    if (!ins) {
      const old = (await db.one<Row>('select id, status, status_reason, transcript, provider_message_id from notify_outbox where org_id = $1 and dedupe_key = $2 and channel = $3', [m.orgId, m.dedupeKey.slice(0, 200), channel]))!
      return { id: old.id, status: old.status, reason: old.status_reason, duplicate: true, transcript: old.transcript }
    }
    if (hold || !c) return { id: ins.id, status: 'held', reason: hold, duplicate: false, transcript }
    const form = new URLSearchParams({ To: m.toPhone })
    if (channel === 'text') { form.set('Body', body); if (c.messagingServiceSid) form.set('MessagingServiceSid', c.messagingServiceSid); else form.set('From', c.from!) }
    else { form.set('From', c.from!); form.set('Twiml', twiml(transcript!)) }
    const path = channel === 'text' ? 'Messages.json' : 'Calls.json'
    let status: 'sent' | 'failed' = 'failed', reason: string | null = null, sid: string | null = null
    try {
      const res = await http(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/${path}`, {
        method: 'POST', body: form.toString(), signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      })
      const j = await res.json().catch(() => ({})) as { sid?: string; message?: string; code?: number }
      if (res.ok && j.sid) { status = 'sent'; sid = j.sid } else reason = `Twilio refused (${res.status}${j.code ? ` ${j.code}` : ''}): ${String(j.message ?? 'no reason given').slice(0, 300)}`
    } catch (e) { reason = `Twilio did not answer: ${(e as Error).name}` }
    await db.query('update notify_outbox set status = $2, status_reason = $3, provider_message_id = $4 where id = $1', [ins.id, status, reason, sid])
    if (status === 'sent' && channel === 'text') await recordAction(db, { orgId: m.orgId, agentKey: m.audience, type: 'send_text', kind: 'text', proofRef: `notify_outbox:${ins.id}`, dedupeKey: `text:${ins.id}` })
    return { id: ins.id, status, reason, duplicate: false, transcript }
  }
  return { name: 'twilio', sendText: (db, m) => deliver(db, m, 'text'), sendVoiceNote: (db, m) => deliver(db, m, 'voice') }
}

/**
 * Twilio's webhook signature: base64(HMAC-SHA1(authToken, fullUrl + each POST param name+value, sorted by name)).
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('')
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64')
}
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | null): boolean {
  if (!header) return false
  const want = Buffer.from(twilioSignature(authToken, url, params)), got = Buffer.from(header)
  return want.length === got.length && timingSafeEqual(want, got)
}
