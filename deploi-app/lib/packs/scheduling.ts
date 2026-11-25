/**
 * Visit, tour and showing times from the calendar port (free/busy -> the Office slot rules in
 * lib/office/slots.ts), and booking one: a deterministic event id (a repeat books nothing new), a
 * pack_appointments row, and a fresh read of the event as the proof.
 */
import { createHash } from 'node:crypto'
import type { Db } from '../db'
import { proposeSlots, type Slot, type SlotRules } from '../office/slots'
import type { ProofItem } from '../notify'
import { PortError, portsFor } from './ports'
import type { PackConfig } from './settings'

export const HORIZON_DAYS = 10
export function rulesFor(c: PackConfig, durationMin: number): SlotRules {
  return { timezone: c.timezone, days: c.days, dayStart: c.dayStart, dayEnd: c.dayEnd, durationMin, bufferMin: 15, minNoticeHours: 12, horizonDays: HORIZON_DAYS, stepMin: 60 }
}

/** Up to three open times; [] when the calendar is full; throws PortError when the calendar does not answer. */
export async function openSlots(orgId: string, c: PackConfig, durationMin: number, now: Date): Promise<Slot[]> {
  const ports = await portsFor(orgId)
  const busy = await ports.calendar.freeBusy({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + (HORIZON_DAYS + 2) * 864e5).toISOString(), timeZone: c.timezone })
  return proposeSlots(busy, rulesFor(c, durationMin), now, 3)
}

/** "1", "option 2", "the third one" (only when we offered times). */
export function slotChoice(text: string): number | null {
  const body = text.toLowerCase().split(/\n\s*(?:on .{4,200} wrote:|>)/)[0]
  const m = /\b(?:option|number|no\.?|#|slot|choice|time)\s*([123])\b/.exec(body) ?? /^\s*([123])[.)]?\s*(?:$|[a-z ,!.]*$)/m.exec(body)
  const word = /\b(first|second|third)\b/.exec(body)
  return m ? Number(m[1]) : word ? ['first', 'second', 'third'].indexOf(word[1]) + 1 : null
}

export const eventIdFor = (orgId: string, leadId: string, kind: string, start: string) => `dp${createHash('sha256').update(`${orgId}|${leadId}|${kind}|${start}`).digest('hex').slice(0, 26)}`

export type Booked = { appointmentId: string; eventId: string; slot: Slot }
/** Book a slot. Throws PortError('refused') when the time was taken in the meantime. */
export async function bookSlot(db: Db, orgId: string, i: { leadId: string; kind: 'quote_visit' | 'tour' | 'showing' | 'meeting'; slot: Slot; summary: string; description: string; attendee: string | null; timezone: string }): Promise<Booked> {
  const existing = await db.one<{ id: string; calendar_event_id: string }>(`select id, calendar_event_id from pack_appointments where org_id = $1 and lead_id = $2 and kind = $3 and status = 'booked'`, [orgId, i.leadId, i.kind])
  if (existing) return { appointmentId: existing.id, eventId: existing.calendar_event_id, slot: i.slot }
  const ports = await portsFor(orgId)
  const id = eventIdFor(orgId, i.leadId, i.kind, i.slot.start)
  const ev = await ports.calendar.insertEvent({ id, summary: i.summary, description: i.description, start: i.slot.start, end: i.slot.end, timeZone: i.timezone, attendees: i.attendee ? [i.attendee] : [], meet: false, requestId: id })
  const row = (await db.one<{ id: string }>(`insert into pack_appointments (org_id, lead_id, kind, starts_at, ends_at, calendar_event_id) values ($1,$2,$3,$4,$5,$6) returning id`, [orgId, i.leadId, i.kind, ev.start, ev.end, ev.id]))!
  return { appointmentId: row.id, eventId: ev.id, slot: i.slot }
}

export async function verifyEvent(orgId: string, eventId: string, start: string): Promise<{ ok: boolean; proof: ProofItem[] }> {
  try {
    const ev = await (await portsFor(orgId)).calendar.getEvent(eventId)
    if (!ev || ev.status === 'cancelled') return { ok: false, proof: [{ label: 'Calendar event not found on a fresh read', value: eventId }] }
    const same = Date.parse(ev.start) === Date.parse(start)
    return { ok: same, proof: [{ label: same ? 'Calendar event confirmed (fresh read)' : 'Calendar event is at a different time', value: `${ev.summary}: ${ev.start}`, url: ev.htmlLink }] }
  } catch (e) {
    return { ok: false, proof: [{ label: 'The calendar did not answer the check', value: e instanceof PortError ? e.message : 'unexpected error' }] }
  }
}
