/** Smartlead webhook event handling. Runs as service role (no user). */
import type { Db } from '../db'
import { advances } from './stages'

export const SMARTLEAD_EVENTS = ['EMAIL_SENT', 'EMAIL_REPLIED', 'EMAIL_BOUNCED', 'LEAD_UNSUBSCRIBED'] as const
export type SmartleadEvent = typeof SMARTLEAD_EVENTS[number]

export type SmartleadPayload = {
  event_type: string
  to_email?: string; lead_email?: string; email?: string
  to_name?: string; lead_name?: string; first_name?: string; last_name?: string
  company_name?: string; agency_name?: string
  subject?: string; email_subject?: string
  reply_body?: string; email_body?: string; body?: string; preview_text?: string
  time_sent?: string; event_timestamp?: string; reply_time?: string
  campaign_name?: string; campaign_id?: string | number
  secret_key?: string
}

export function extract(p: SmartleadPayload) {
  const email = (p.to_email ?? p.lead_email ?? p.email ?? '').trim().toLowerCase()
  const name = p.to_name ?? p.lead_name ?? [p.first_name, p.last_name].filter(Boolean).join(' ') ?? null
  const agency = p.company_name ?? p.agency_name ?? null
  const subject = p.subject ?? p.email_subject ?? null
  const body = p.reply_body ?? p.email_body ?? p.body ?? p.preview_text ?? null
  const at = p.reply_time ?? p.event_timestamp ?? p.time_sent ?? new Date().toISOString()
  return { email, name: name || null, agency, subject, body, at, campaign: p.campaign_name ?? (p.campaign_id ? String(p.campaign_id) : null) }
}

export type HandleResult = { handled: boolean; prospectId?: string; created?: boolean; stage?: string; reason?: string }

export async function handleSmartleadEvent(db: Db, p: SmartleadPayload): Promise<HandleResult> {
  const type = String(p.event_type ?? '').toUpperCase()
  if (!(SMARTLEAD_EVENTS as readonly string[]).includes(type)) return { handled: false, reason: `ignored event ${type || '(none)'}` }
  const e = extract(p)
  if (!e.email) return { handled: false, reason: 'no email in payload' }
  let row = await db.one<{ id: string; stage: string; owner_notes: string | null }>('select id, stage::text as stage, owner_notes from prospects where lower(email) = $1 order by created_at limit 1', [e.email])
  let created = false
  if (!row) {
    if (type !== 'EMAIL_SENT') return { handled: false, reason: 'unknown prospect' }
    row = await db.one<{ id: string; stage: string; owner_notes: string | null }>(
      `insert into prospects (agency_name, owner_name, email, source, stage) values ($1,$2,$3,'smartlead','new') returning id, stage::text as stage, owner_notes`,
      [e.agency ?? e.name ?? e.email.split('@')[1] ?? 'Unknown agency', e.name, e.email])
    created = true
  }
  const id = row!.id
  const meta = { event: type, campaign: e.campaign }
  if (type === 'EMAIL_SENT') {
    await db.query(`insert into touches (prospect_id, channel, direction, subject, body, at, meta) values ($1,'email','outbound',$2,$3,$4,$5)`, [id, e.subject, e.body, e.at, meta])
    if (advances(row!.stage, 'contacted')) await db.query(`update prospects set stage = 'contacted' where id = $1`, [id])
  } else if (type === 'EMAIL_REPLIED') {
    await db.query(`insert into touches (prospect_id, channel, direction, subject, body, at, meta) values ($1,'email','inbound',$2,$3,$4,$5)`, [id, e.subject, e.body, e.at, meta])
    if (advances(row!.stage, 'replied')) await db.query(`update prospects set stage = 'replied' where id = $1`, [id])
  } else if (type === 'EMAIL_BOUNCED') {
    await db.query(`insert into touches (prospect_id, channel, direction, subject, body, at, meta) values ($1,'email','inbound','Bounced',$2,$3,$4)`, [id, e.body ?? 'Email bounced', e.at, meta])
    await db.query(`update prospects set email_invalid = true where id = $1`, [id])
  } else if (type === 'LEAD_UNSUBSCRIBED') {
    await db.query(`insert into touches (prospect_id, channel, direction, subject, body, at, meta) values ($1,'email','inbound','Unsubscribed',$2,$3,$4)`, [id, e.body ?? 'Lead unsubscribed', e.at, meta])
    const note = `[${e.at.slice(0, 10)}] Unsubscribed via Smartlead`
    await db.query(`update prospects set stage = 'lost', owner_notes = concat_ws(E'\\n', nullif(owner_notes,''), $2::text) where id = $1`, [id, note])
  }
  const after = await db.one<{ stage: string }>('select stage::text as stage from prospects where id = $1', [id])
  return { handled: true, prospectId: id, created, stage: after?.stage }
}
