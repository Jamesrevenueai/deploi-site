/**
 * Office phone agents (Track B). Behind OFFICE_PHONE_AGENTS=on (off by default: without it no handler acts, no
 * agent is listed and the phone webhooks answer 404). Both run on the shared pack loop (detect -> act -> verify
 * with a fresh read -> proof -> owner update), and text through the channel adapter (lib/notify/channels.ts):
 * simulated by default, Twilio when NOTIFY_SMS_PROVIDER=twilio, and then only to NOTIFY_ALLOWED_NUMBERS in test mode.
 *
 *   ph_missed_call   a call the business did not answer -> the caller gets a text back (within a minute of the call
 *                    reaching Deploi) asking what they need -> their reply becomes a lead in the CRM -> the owner
 *                    gets a text with the link -> the Booking Agent takes over
 *   ph_booking       offers three open times from the business's calendar by text, books the one the caller picks,
 *                    confirms it, reminds them the day before, and handles "reschedule" and "cancel"
 *
 * Opt-out: STOP (and the usual variants) closes the lead and no further text is sent to that number by these agents.
 * The calendar, CRM and invoicing are the pack ports (lib/packs/ports.ts): synthetic until real clients are wired.
 */
import { admin, type Db } from '../db'
import type { Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { audit } from '../engine/audit'
import { assertCan } from '../platform/rbac'
import { onEvent, type AgentEvent } from '../events'
import { channelAdapter, normalizePhone } from '../notify/channels'
import type { ProofItem } from '../notify'
import { formatInTimeZone } from 'date-fns-tz'
import type { Slot } from '../office/slots'
import { registerPackAgents, type PackAgent } from './registry'
import { runPackLoop, PackBlocked, type PackOutcome } from './loop'
import { intakeLead, type LeadRow } from './leads'
import { PortError, portsFor } from './ports'
import { orgPacks, type OrgPacks } from './settings'
import { bookSlot, openSlots, slotChoice, verifyEvent, HORIZON_DAYS } from './scheduling'
import { eventNow, hours, rowProof, str } from './kit'

const PACK = 'office' as const
export const PHONE_PATH = '/store/packs/office'
export const phoneAgentsOn = (env: Record<string, string | undefined> = process.env) => (env.OFFICE_PHONE_AGENTS ?? '').trim().toLowerCase() === 'on'

export const PHONE_AGENTS: PackAgent[] = [
  { key: 'ph_missed_call', name: 'Missed Call Agent', pack: PACK, job: 'When you miss a call, texts the caller back within a minute, asks what they need, adds them to your CRM as a lead and texts you the details with a link.', triggers: ['call.missed', 'sms.received'], actions: ['send_text', 'update_crm'], status: 'synthetic_only', shopifyReady: false },
  { key: 'ph_booking', name: 'Booking Agent', pack: PACK, job: 'Offers open times from your calendar by text, books the job, confirms it, reminds the customer the day before and handles reschedules.', triggers: ['sms.received', 'sweep'], actions: ['book_appointment', 'send_text'], status: 'synthetic_only', shopifyReady: false },
]
const NAME = Object.fromEntries(PHONE_AGENTS.map(a => [a.key, a.name])) as Record<string, string>

// ---------------------------------------------------------------- words

const clean = (s: string | null | undefined, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
export const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel all|end|quit|opt ?out)\s*[.!]*\s*$/i
export const wantsReschedule = (t: string) => /\b(reschedul\w*|change (?:the |my )?(?:time|day|date|appointment)|move (?:it|the appointment)|different (?:time|day)|another (?:time|day)|can'?t make it|cannot make it)\b|^\s*r\s*$/i.test(t)
export const wantsCancel = (t: string) => /\b(cancel(?:led)?(?: (?:it|the appointment|my appointment))?)\b/i.test(t) && !wantsReschedule(t)
export function missedCallText(business: string): string {
  return `Hi, this is ${clean(business, 60)}. Sorry we missed your call! What can we help you with? Reply here and we'll get you booked. Reply STOP to opt out.`
}
export function timesText(business: string, slots: Slot[], again: boolean): string {
  const list = slots.map((s, i) => `${i + 1}) ${s.label}`).join('\n')
  return `${again ? 'No problem. ' : 'Thanks! '}${clean(business, 60)} can come out at:\n${list}\nReply 1, 2 or 3 to book.`
}
export const confirmText = (business: string, s: Slot) => `You're booked with ${clean(business, 60)} for ${s.label}. We'll text a reminder the day before. Reply R to reschedule.`
export const reminderText = (business: string, label: string) => `Reminder: ${clean(business, 60)} is booked to come out tomorrow, ${label}. Reply R to reschedule or CANCEL to cancel.`
export const cancelText = (business: string) => `Your appointment with ${clean(business, 60)} is cancelled. Text us any time to book again.`
const masked = (p: string) => `${p.slice(0, -4).replace(/\d/g, '•')}${p.slice(-4)}`

// ---------------------------------------------------------------- data

export type PhoneCall = { id: string; org_id: string; provider_call_id: string; from_phone: string; to_phone: string; call_status: string; occurred_at: string; state: string; texted_at: string | null; lead_id: string | null }
type Appt = { id: string; lead_id: string; starts_at: string; ends_at: string; calendar_event_id: string; status: string; reminder_sent_at: string | null }

/** The lead pack a phone lead belongs to: home services when the business has it (so dispatch, invoicing and payment follow-up continue), else office. */
const leadPack = (org: OrgPacks) => (org.packs.includes('home_services') ? 'home_services' : 'office')

async function optedOut(db: Db, orgId: string, phone: string): Promise<boolean> {
  return Boolean(await db.one(`select 1 from phone_calls where org_id = $1 and from_phone = $2 and state = 'opted_out' limit 1`, [orgId, phone]))
}
/** The open phone lead for a number: the newest one not closed. */
export async function phoneLead(db: Db, orgId: string, phone: string): Promise<LeadRow | null> {
  return db.one<LeadRow>(`select * from pack_leads where org_id = $1 and phone = $2 and source = 'phone' and status not in ('lost', 'stopped', 'duplicate', 'won')
    order by created_at desc limit 1`, [orgId, phone])
}

async function text(db: Db, orgId: string, to: string, leadId: string | null, body: string, dedupeKey: string): Promise<{ proof: ProofItem; outboxId: string }> {
  const r = await channelAdapter().sendText(db, { orgId, audience: 'customer', recipientRef: leadId, toPhone: to, dedupeKey, body })
  if (r.status === 'failed') throw new Error(`the text to ${masked(to)} did not go out: ${r.reason ?? 'no reason given'}`)
  if (r.status === 'held') throw new PackBlocked(`the text to ${masked(to)} was held (${r.reason}); call them back on ${to}`)
  return { proof: rowProof(`Text to ${masked(to)} (${r.status})`, body), outboxId: r.id }
}
async function verifyText(db: Db, outboxId: string, label: string): Promise<{ ok: boolean; proof: ProofItem[] }> {
  const row = await db.one<{ status: string; provider: string; created_at: string }>('select status, provider, created_at from notify_outbox where id = $1', [outboxId])
  const ok = Boolean(row && (row.status === 'sent' || row.status === 'simulated'))
  return { ok, proof: [rowProof(`${label} (fresh read of the outbox)`, row ? `${row.status} via ${row.provider} at ${row.created_at}` : 'not found')] }
}

// ---------------------------------------------------------------- ph_missed_call: text back

export async function onMissedCall(db: Db, e: AgentEvent): Promise<PackOutcome | null> {
  if (!phoneAgentsOn()) return null
  const from = normalizePhone(e.payload.from), to = normalizePhone(e.payload.to), callId = str(e.payload.callId, 120)
  if (!from || !to || !callId) return null
  const org = await orgPacks(db, e.orgId)
  const now = eventNow(e)
  const status = ['no-answer', 'busy', 'failed', 'canceled'].includes(String(e.payload.status)) ? String(e.payload.status) : 'missed'
  await db.query(`insert into phone_calls (org_id, provider_call_id, from_phone, to_phone, call_status, occurred_at) values ($1,$2,$3,$4,$5,$6) on conflict (org_id, provider_call_id) do nothing`,
    [e.orgId, callId, from, to, status, now.toISOString()])
  const call = (await db.one<PhoneCall>('select * from phone_calls where org_id = $1 and provider_call_id = $2', [e.orgId, callId]))!
  const at = formatInTimeZone(now, org.config.timezone, 'EEE d MMM, HH:mm')
  return runPackLoop(db, PACK, {
    orgId: e.orgId, agentKey: 'ph_missed_call', agentName: NAME.ph_missed_call, actionType: 'send_text', problemKey: `call:${call.id}:textback`, detailsPath: PHONE_PATH,
    detect: async d => {
      const c = await d.one<PhoneCall>(`select * from phone_calls where id = $1 and state = 'new'`, [call.id])
      if (!c) return null
      if (await optedOut(d, e.orgId, from)) { await d.query(`update phone_calls set state = 'opted_out' where id = $1`, [c.id]); return null }
      return { c, outboxId: '', leadId: '' }
    },
    describe: () => ({ title: `Missed call from ${masked(from)}: texted back`, whatHappened: `You missed a call from ${from} (${at}).`, whatIDid: ['Texted the caller back to ask what they need.'] }),
    act: async (d, p) => {
      const { lead } = await intakeLead(d, e.orgId, leadPack(org), { source: 'phone', externalId: `call:${callId}`, name: null, email: null, phone: from, subject: 'Missed call', criteria: {}, intent: 'service' }, 'service')
      const t = await text(d, e.orgId, from, lead.id, missedCallText(org.config.senderName), `ph:call:${callId}:textback`)
      const texted = await d.one<{ texted_at: string }>(`update phone_calls set state = 'texted', texted_at = now(), lead_id = $2 where id = $1 returning texted_at`, [p.c.id, lead.id])
      await d.query(`update pack_leads set status = 'replied', replied_at = now() where id = $1 and status = 'new'`, [lead.id])
      p.outboxId = t.outboxId; p.leadId = lead.id
      const secs = Math.max(0, Math.round((Date.parse(texted!.texted_at) - now.getTime()) / 1000))
      return { proof: [t.proof, rowProof('Time from the missed call to the text', `${secs} seconds`)] }
    },
    verify: (d, p) => verifyText(d, p.outboxId, 'Text back'),
  })
}

// ---------------------------------------------------------------- ph_missed_call: capture the need, CRM lead, owner text

export async function captureNeed(db: Db, e: AgentEvent, lead: LeadRow, body: string): Promise<PackOutcome> {
  const need = clean(body, 300)
  return runPackLoop(db, PACK, {
    orgId: e.orgId, agentKey: 'ph_missed_call', agentName: NAME.ph_missed_call, actionType: 'update_crm', problemKey: `lead:${lead.id}:capture`, detailsPath: `${PHONE_PATH}?lead=${lead.id}`,
    detect: async d => (await d.one<LeadRow>(`select * from pack_leads where id = $1 and status = 'replied'`, [lead.id])) ? { contactId: '' } : null,
    describe: () => ({
      title: `New lead from a missed call: ${clean(need, 80)}`,
      whatHappened: `The caller ${lead.phone} replied to the text-back: "${need}"`,
      whatIDid: ['Added them to your CRM as a new lead with what they need.', 'Texting them open times to book.'],
    }),
    act: async (d, p) => {
      const crm = (await portsFor(e.orgId)).crm
      const c = await crm.upsertContact({ email: lead.email, name: lead.name, phone: lead.phone, stage: 'new lead', tags: ['missed call', 'phone'] })
      await crm.addNote(c.id, `Missed call ${lead.phone}. Needs: ${need}`, `ph:lead:${lead.id}:need`)
      await d.query(`update pack_leads set status = 'qualifying', subject = $2, criteria = criteria || $3, crm_record_id = $4, last_inbound_at = now() where id = $1`,
        [lead.id, clean(need, 300), JSON.stringify({ need }), c.id])
      await d.query(`update phone_calls set state = 'captured' where lead_id = $1 and state = 'texted'`, [lead.id])
      p.contactId = c.id
      return { proof: [rowProof(`CRM lead created (${crm.provider})`, `contact ${c.id}, stage ${c.stage ?? 'new lead'}`), rowProof('What they need', need)] }
    },
    verify: async (_d, p) => {
      const c = await (await portsFor(e.orgId)).crm.getContact(p.contactId)
      const ok = Boolean(c && c.notes.some(n => n.includes(need.slice(0, 40))))
      return { ok, proof: [rowProof('CRM contact (fresh read)', c ? `${c.id}: ${c.stage ?? ''}, ${c.notes.length} note(s)` : 'not found')] }
    },
  })
}

// ---------------------------------------------------------------- ph_booking: offer times

export async function offerTimes(db: Db, orgId: string, lead: LeadRow, org: OrgPacks, now: Date, round: number): Promise<PackOutcome> {
  return runPackLoop(db, PACK, {
    orgId, agentKey: 'ph_booking', agentName: NAME.ph_booking, actionType: 'send_text', problemKey: `lead:${lead.id}:offer:${round}`, detailsPath: `${PHONE_PATH}?lead=${lead.id}`,
    detect: async d => {
      const l = await d.one<LeadRow>(`select * from pack_leads where id = $1 and status in ('qualifying', 'replied', 'booked', 'slots_offered')`, [lead.id])
      if (!l || !l.phone) return null
      let slots: Slot[] = []
      try { slots = await openSlots(orgId, org.config, org.config.visitMinutes, now) } catch (err) { throw new PackBlocked(`the calendar did not answer (${err instanceof PortError ? err.message : 'error'}); call ${l.phone} to book`) }
      if (!slots.length) throw new PackBlocked(`your calendar is full for the next ${HORIZON_DAYS} days; call ${l.phone} to book`)
      return { l, slots, outboxId: '' }
    },
    describe: p => ({ title: `Offered ${p.slots.length} times to ${masked(p.l.phone!)}`, whatHappened: `${masked(p.l.phone!)} needs: ${p.l.subject ?? 'a visit'}.`, whatIDid: [`Texted ${p.slots.length} open times from your calendar.`] }),
    act: async (d, p) => {
      const t = await text(d, orgId, p.l.phone!, p.l.id, timesText(org.config.senderName, p.slots, round > 0), `ph:lead:${p.l.id}:offer:${round}`)
      await d.query(`update pack_leads set status = 'slots_offered', proposed_slots = $2 where id = $1`, [p.l.id, JSON.stringify(p.slots)])
      p.outboxId = t.outboxId
      return { proof: [t.proof] }
    },
    verify: (d, p) => verifyText(d, p.outboxId, 'Times texted'),
  })
}

// ---------------------------------------------------------------- ph_booking: book, cancel, reschedule

async function bookChoice(db: Db, orgId: string, lead: LeadRow, slot: Slot, org: OrgPacks): Promise<PackOutcome> {
  return runPackLoop(db, PACK, {
    orgId, agentKey: 'ph_booking', agentName: NAME.ph_booking, actionType: 'book_appointment', problemKey: `lead:${lead.id}:book:${slot.start}`, detailsPath: `${PHONE_PATH}?lead=${lead.id}`,
    detect: async d => (await d.one(`select 1 from pack_leads where id = $1 and status = 'slots_offered'`, [lead.id])) ? { eventId: '', start: '' } : null,
    describe: () => ({ title: `Booked ${masked(lead.phone!)} for ${slot.label}`, whatHappened: `${masked(lead.phone!)} picked ${slot.label}.`, whatIDid: ['Booked it on your calendar.', 'Texted them a confirmation.'] }),
    act: async (d, p) => {
      let b
      try {
        b = await bookSlot(d, orgId, { leadId: lead.id, kind: 'quote_visit', slot, summary: `Visit: ${clean(lead.subject, 80) || 'phone lead'} (${lead.phone})`, description: `Booked by text by the Booking Agent. Caller ${lead.phone}. Needs: ${lead.subject ?? ''}`, attendee: lead.email, timezone: org.config.timezone })
      } catch (err) { if (err instanceof PortError && err.code === 'refused') throw new PackBlocked('that time was taken in the meantime; offering new times'); throw err }
      await d.query(`update pack_leads set status = 'booked', next_follow_up_at = null where id = $1`, [lead.id])
      await d.query(`update phone_calls set state = 'booked' where lead_id = $1`, [lead.id])
      const t = await text(d, orgId, lead.phone!, lead.id, confirmText(org.config.senderName, slot), `ph:appt:${b.appointmentId}:confirm`)
      p.eventId = b.eventId; p.start = slot.start
      return { proof: [rowProof('Calendar event', `${b.eventId}: ${slot.label}`), t.proof] }
    },
    verify: async (_d, p) => verifyEvent(orgId, p.eventId, p.start),
  })
}

async function cancelBooking(db: Db, orgId: string, lead: LeadRow, org: OrgPacks, then: 'reschedule' | 'cancel', round: number): Promise<PackOutcome> {
  return runPackLoop(db, PACK, {
    orgId, agentKey: 'ph_booking', agentName: NAME.ph_booking, actionType: 'book_appointment', problemKey: `lead:${lead.id}:${then}:${round}`, detailsPath: `${PHONE_PATH}?lead=${lead.id}`,
    detect: async d => {
      const a = await d.one<Appt>(`select * from pack_appointments where org_id = $1 and lead_id = $2 and status = 'booked' order by starts_at desc limit 1`, [orgId, lead.id])
      return a ? { a, outboxId: '' } : null
    },
    describe: p => ({
      title: then === 'reschedule' ? `${masked(lead.phone!)} asked to reschedule` : `${masked(lead.phone!)} cancelled`,
      whatHappened: `${masked(lead.phone!)} texted that they ${then === 'reschedule' ? 'need a different time' : 'want to cancel'} (booked ${formatInTimeZone(new Date(p.a.starts_at), org.config.timezone, 'EEE d MMM, HH:mm')}).`,
      whatIDid: then === 'reschedule' ? ['Cancelled the old time on your calendar.', 'Texting new times.'] : ['Cancelled it on your calendar.', 'Texted them that it is cancelled.'],
    }),
    act: async (d, p) => {
      const cal = (await portsFor(orgId)).calendar
      if (!cal.cancelEvent) throw new PackBlocked(`your calendar (${cal.provider}) cannot cancel events from Deploi yet; move it yourself and text ${lead.phone}`)
      await cal.cancelEvent(p.a.calendar_event_id)
      await d.query(`update pack_appointments set status = 'cancelled' where id = $1`, [p.a.id])
      await d.query(`update pack_leads set status = $2 where id = $1`, [lead.id, then === 'reschedule' ? 'qualifying' : 'lost'])
      const proof = [rowProof('Calendar event cancelled', p.a.calendar_event_id)]
      if (then === 'cancel') { const t = await text(d, orgId, lead.phone!, lead.id, cancelText(org.config.senderName), `ph:appt:${p.a.id}:cancelled`); p.outboxId = t.outboxId; proof.push(t.proof) }
      return { proof }
    },
    verify: async (_d, p) => {
      const ev = await (await portsFor(orgId)).calendar.getEvent(p.a.calendar_event_id)
      return { ok: !ev || ev.status === 'cancelled', proof: [rowProof('Calendar event (fresh read)', ev ? `${ev.id}: ${ev.status}` : 'gone')] }
    },
  })
}

// ---------------------------------------------------------------- inbound texts

export async function onInboundText(db: Db, e: AgentEvent): Promise<PackOutcome | null> {
  if (!phoneAgentsOn()) return null
  const from = normalizePhone(e.payload.from), body = clean(str(e.payload.body, 1600), 1600), msgId = str(e.payload.messageId, 120)
  if (!from || !body || !msgId) return null
  await db.query(`insert into phone_texts (org_id, provider_message_id, from_phone, to_phone, body, received_at) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
    [e.orgId, msgId, from, normalizePhone(e.payload.to) ?? from, body, eventNow(e).toISOString()])
  const org = await orgPacks(db, e.orgId)
  const lead = await phoneLead(db, e.orgId, from)
  if (STOP_WORDS.test(body)) {
    // the provider confirms the opt-out to the person; Deploi stops texting them and closes the lead
    await db.query(`update phone_calls set state = 'opted_out' where org_id = $1 and from_phone = $2`, [e.orgId, from])
    if (lead) await db.query(`update pack_leads set status = 'stopped', next_follow_up_at = null where id = $1`, [lead.id])
    await db.query(`update pack_appointments set status = 'cancelled' where org_id = $1 and status = 'booked' and lead_id in (select id from pack_leads where org_id = $1 and phone = $2)`, [e.orgId, from])
    return null
  }
  if (!lead) return null
  const now = eventNow(e)
  const round = await db.one<{ n: number }>(`select count(*)::int as n from pack_appointments where lead_id = $1 and status = 'cancelled'`, [lead.id])
  if (lead.status === 'replied') {
    const out = await captureNeed(db, e, lead, body)
    if (out.status !== 'done' && out.status !== 'already_done') return out
    const fresh = (await db.one<LeadRow>('select * from pack_leads where id = $1', [lead.id]))!
    return offerTimes(db, e.orgId, fresh, org, now, 0)
  }
  if (lead.status === 'slots_offered') {
    const n = slotChoice(body)
    const slot = n ? lead.proposed_slots[n - 1] : null
    if (slot) {
      const out = await bookChoice(db, e.orgId, lead, slot, org)
      if (out.status === 'failed' && /taken in the meantime/.test(out.error)) await db.query(`update pack_leads set status = 'qualifying' where id = $1`, [lead.id])
      return out
    }
    return null
  }
  if (lead.status === 'booked' && (wantsReschedule(body) || wantsCancel(body))) {
    const then = wantsReschedule(body) ? 'reschedule' : 'cancel'
    const out = await cancelBooking(db, e.orgId, lead, org, then, round?.n ?? 0)
    if (then === 'reschedule' && out.status === 'done') {
      const fresh = (await db.one<LeadRow>('select * from pack_leads where id = $1', [lead.id]))!
      return offerTimes(db, e.orgId, fresh, org, now, (round?.n ?? 0) + 1)
    }
    return out
  }
  return null
}

// ---------------------------------------------------------------- ph_booking: the day-before reminder (sweep)

export async function sweepReminders(db: Db, e: AgentEvent): Promise<number> {
  if (!phoneAgentsOn()) return 0
  const now = eventNow(e)
  const org = await orgPacks(db, e.orgId)
  const due = await db.query<Appt & { phone: string }>(`select a.*, l.phone from pack_appointments a join pack_leads l on l.id = a.lead_id
    where a.org_id = $1 and a.status = 'booked' and a.reminder_sent_at is null and l.source = 'phone' and l.phone is not null and l.status = 'booked'
      and a.starts_at > $2 and a.starts_at <= $3 order by a.starts_at limit 50`, [e.orgId, now.toISOString(), new Date(now.getTime() + hours(24)).toISOString()])
  let n = 0
  for (const a of due) {
    if (await optedOut(db, e.orgId, a.phone)) continue
    const label = formatInTimeZone(new Date(a.starts_at), org.config.timezone, 'EEEE d MMMM, HH:mm')
    const out = await runPackLoop(db, PACK, {
      orgId: e.orgId, agentKey: 'ph_booking', agentName: NAME.ph_booking, actionType: 'send_text', problemKey: `appt:${a.id}:reminder`, detailsPath: `${PHONE_PATH}?lead=${a.lead_id}`,
      detect: async d => (await d.one(`select 1 from pack_appointments where id = $1 and status = 'booked' and reminder_sent_at is null`, [a.id])) ? { outboxId: '' } : null,
      describe: () => ({ title: `Reminder texted to ${masked(a.phone)}`, whatHappened: `${masked(a.phone)} is booked for ${label}.`, whatIDid: ['Texted them a reminder the day before.'] }),
      act: async (d, p) => {
        const t = await text(d, e.orgId, a.phone, a.lead_id, reminderText(org.config.senderName, label), `ph:appt:${a.id}:reminder`)
        await d.query(`update pack_appointments set reminder_sent_at = now() where id = $1`, [a.id])
        p.outboxId = t.outboxId
        return { proof: [t.proof] }
      },
      verify: (d, p) => verifyText(d, p.outboxId, 'Reminder'),
    })
    if (out.status === 'done') n++
  }
  return n
}

// ---------------------------------------------------------------- registration

let registered = false
export function registerPhone(env: Record<string, string | undefined> = process.env) {
  if (registered) return
  registered = true
  // listed (dashboards, the Office agent list) only when the flag is on; the handlers check the flag on every event
  if (phoneAgentsOn(env)) registerPackAgents(PHONE_AGENTS)
  onEvent('call.missed', 'ph_missed_call', async (db, e) => { await onMissedCall(db, e) })
  onEvent('sms.received', 'ph_booking', async (db, e) => { await onInboundText(db, e) })
  onEvent('sweep', 'ph_booking_reminders', async (db, e) => { await sweepReminders(db, e) })
}

// ---------------------------------------------------------------- the business's phone line (owner settings)

const orgOf = (actor: Actor) => { if (actor.kind === 'staff') throw new EngineError('forbidden', 'a phone line belongs to a customer organization'); return actor.orgId }

/**
 * Set the business's Deploi number (the one its missed calls forward to, bought from the provider) and, optionally,
 * the phone that rings first. Owners and admins only (settings permission); the flag must be on.
 */
export async function setPhoneLine(actor: Actor, input: Record<string, unknown>) {
  if (!phoneAgentsOn()) throw new EngineError('not_operational', 'the phone agents are not switched on in this environment (OFFICE_PHONE_AGENTS)')
  const orgId = orgOf(actor)
  const phone = normalizePhone(input.phoneNumber), forward = input.forwardTo ? normalizePhone(input.forwardTo) : null
  if (!phone) throw new EngineError('invalid_input', 'the Deploi number must be in international form, for example +15550100100')
  if (input.forwardTo && !forward) throw new EngineError('invalid_input', 'the phone that rings first must be in international form, for example +15550100100')
  if (forward === phone) throw new EngineError('invalid_input', 'the phone that rings first cannot be the Deploi number itself')
  return admin(async db => {
    await assertCan(actor, orgId, 'settings', db)
    const taken = await db.one<{ org_id: string }>('select org_id from office_phone_lines where phone_number = $1', [phone])
    if (taken && taken.org_id !== orgId) throw new EngineError('forbidden', 'that number is already connected to another business')
    const r = (await db.one<{ id: string }>(`insert into office_phone_lines (org_id, phone_number, forward_to, active) values ($1,$2,$3,true)
      on conflict (phone_number) do update set forward_to = excluded.forward_to, active = true returning id`, [orgId, phone, forward]))!
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'phone.line_set', actor: actor.label, detail: { line_id: r.id, forwards: Boolean(forward) } })
    return { id: r.id, phoneNumber: phone, forwardTo: forward }
  })
}
