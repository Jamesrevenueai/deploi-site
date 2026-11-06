/**
 * Text messages and voice notes behind one adapter interface. NOTIFY_SMS_PROVIDER picks the sender:
 *
 *   simulated (default)  the message is stored in notify_outbox with status "simulated" and nothing leaves
 *                        Deploi; a voice note is stored as the transcript the voice would read.
 *   anything else        no live provider is built in yet: the message is recorded as "held" with the reason,
 *                        and nothing leaves. docs/NOTIFY-CHANNELS.md lists what going live needs (provider
 *                        account, number registration, opt-in and STOP handling, a text-to-speech voice).
 *
 * Every call is idempotent per (organization, dedupe key, channel): a repeat returns the first record.
 */
import { admin, type Db } from '../db'

export type ChannelMessage = {
  orgId: string
  audience: 'owner' | 'crew'
  /** the profile (owner) or crew member the message is for */
  recipientRef: string | null
  toPhone: string
  dedupeKey: string
  body: string
}
export type ChannelResult = { id: string; status: 'simulated' | 'held' | 'sent' | 'failed'; reason: string | null; duplicate: boolean; transcript?: string | null }
export interface ChannelAdapter {
  readonly name: string
  sendText(db: Db, m: ChannelMessage): Promise<ChannelResult>
  /** speak `m.body` as a short voice note; the transcript is what the voice says, word for word */
  sendVoiceNote(db: Db, m: ChannelMessage): Promise<ChannelResult>
}

export const E164 = /^\+[1-9][0-9]{6,14}$/
/** A phone number in E.164 (+15551234567), or null. Spaces, dashes and brackets are removed first. */
export function normalizePhone(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const p = v.replace(/[\s\-().]/g, '')
  return E164.test(p) ? p : null
}

/** The longest text a provider accepts in one message (concatenated segments); owner updates use far less. */
export const TEXT_LIMIT = 1600
/** An owner update by text: about three segments. */
export const OWNER_TEXT_LIMIT = 480
export const clipText = (s: string, n = TEXT_LIMIT) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

/** What the voice note says: a greeting, the message with links spoken as "the link in your text", a sign-off. */
export function voiceTranscript(body: string): string {
  const spoken = body.replace(/https?:\/\/\S+/g, 'the link in your messages').replace(/\s+/g, ' ').trim()
  return `Hi, this is Deploi. ${spoken} That's all for now. Goodbye.`
}

type Row = { id: string; status: ChannelResult['status']; status_reason: string | null; transcript: string | null }

async function record(db: Db, m: ChannelMessage, channel: 'text' | 'voice', provider: string, status: ChannelResult['status'], reason: string | null, transcript: string | null): Promise<ChannelResult> {
  if (!E164.test(m.toPhone)) throw new Error('notify: the phone number must be in E.164 form (+15551234567)')
  const ins = await db.one<Row>(
    `insert into notify_outbox (org_id, audience, recipient_ref, to_phone, channel, provider, dedupe_key, body, transcript, status, status_reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (org_id, dedupe_key, channel) do nothing returning id, status, status_reason, transcript`,
    [m.orgId, m.audience, m.recipientRef, m.toPhone, channel, provider, m.dedupeKey.slice(0, 200), clipText(m.body, 4000), transcript, status, reason])
  if (ins) return { id: ins.id, status: ins.status, reason: ins.status_reason, duplicate: false, transcript: ins.transcript }
  const old = (await db.one<Row>('select id, status, status_reason, transcript from notify_outbox where org_id = $1 and dedupe_key = $2 and channel = $3', [m.orgId, m.dedupeKey.slice(0, 200), channel]))!
  return { id: old.id, status: old.status, reason: old.status_reason, duplicate: true, transcript: old.transcript }
}

/** Stores the message; nothing leaves Deploi. */
export const simulatedAdapter: ChannelAdapter = {
  name: 'simulated',
  sendText: (db, m) => record(db, { ...m, body: clipText(m.body) }, 'text', 'simulated', 'simulated', 'simulated sender (NOTIFY_SMS_PROVIDER=simulated): stored, nothing was sent', null),
  sendVoiceNote: (db, m) => record(db, m, 'voice', 'simulated', 'simulated', 'simulated sender (NOTIFY_SMS_PROVIDER=simulated): transcript stored, nothing was sent', voiceTranscript(m.body)),
}

/** A provider is named but no live sender is built in: recorded as held, nothing leaves. */
function heldAdapter(provider: string): ChannelAdapter {
  const name = /^[a-z][a-z0-9_]{1,30}$/.test(provider) ? provider : 'unknown'
  const why = `the ${name} sender is not set up in this build (see docs/NOTIFY-CHANNELS.md); nothing was sent`
  return {
    name,
    sendText: (db, m) => record(db, { ...m, body: clipText(m.body) }, 'text', name, 'held', why, null),
    sendVoiceNote: (db, m) => record(db, m, 'voice', name, 'held', why, voiceTranscript(m.body)),
  }
}

let override: ChannelAdapter | null = null
/** Tests (and a future live provider module) can install an adapter. null restores the env choice. */
export function setChannelAdapter(a: ChannelAdapter | null) { override = a }

export function channelAdapter(env: Record<string, string | undefined> = process.env): ChannelAdapter {
  if (override) return override
  const p = (env.NOTIFY_SMS_PROVIDER ?? '').trim().toLowerCase() || 'simulated'
  return p === 'simulated' ? simulatedAdapter : heldAdapter(p)
}

/** Convenience for callers without a transaction. */
export const sendText = (m: ChannelMessage) => admin(db => channelAdapter().sendText(db, m))
export const sendVoiceNote = (m: ChannelMessage) => admin(db => channelAdapter().sendVoiceNote(db, m))
