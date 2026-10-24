/**
 * On open shifts: rank eligible aides, propose SMS offers to the top 5, alert the
 * scheduler if still open 30 minutes before start. The YES path lives in the Twilio webhook.
 */
import type { Db } from '@/lib/db'
import { haversineMiles } from '@/lib/workers/geo'
import { suppressShiftOffers } from '@/lib/workers/suppress'
import { initials, type AgencyRow, type Proposal, type WorkerDef } from '@/lib/workers/types'

export type ShiftRow = { id: string; client_id: string; service_code: string; starts_at: string; ends_at: string; status: string; open_since: string | null }
export type ClientRow = { id: string; first_name: string; last_name: string; lat: number | null; lng: number | null }
export type AideRow = { id: string; first_name: string; last_name: string; phone: string | null; services: string[]; active: boolean; lat: number | null; lng: number | null; declined_client_ids: string[]; quit_risk?: boolean }
export type BusyWindow = { aide_id: string; starts_at: string; ends_at: string }
export type Ranked = { aide: AideRow; distanceMiles: number | null; busyHours: number }

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string) {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd)
}

export function rankAides(shift: ShiftRow, client: ClientRow, aides: AideRow[], busy: BusyWindow[], radiusMiles: number, opts: { declinedOfferAideIds?: string[]; weekHours?: Record<string, number> } = {}): Ranked[] {
  const out: Ranked[] = []
  for (const a of aides) {
    if (!a.active) continue
    if (!a.services?.includes(shift.service_code)) continue
    if (a.declined_client_ids?.includes(client.id)) continue
    if (opts.declinedOfferAideIds?.includes(a.id)) continue
    if (busy.some(b => b.aide_id === a.id && overlaps(shift.starts_at, shift.ends_at, b.starts_at, b.ends_at))) continue
    let distance: number | null = null
    if (a.lat != null && a.lng != null && client.lat != null && client.lng != null) {
      distance = haversineMiles(a.lat, a.lng, client.lat, client.lng)
      if (distance > radiusMiles) continue
    }
    out.push({ aide: a, distanceMiles: distance, busyHours: opts.weekHours?.[a.id] ?? 0 })
  }
  return out.sort((x, y) => (x.distanceMiles ?? 1e9) - (y.distanceMiles ?? 1e9) || x.busyHours - y.busyHours)
}

const fmt = (iso: string, tz: string) => new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function buildOfferProposal(shift: ShiftRow, client: ClientRow, r: Ranked, tz: string): Proposal {
  const who = `Aide ${initials(r.aide.first_name, r.aide.last_name)}`
  return {
    kind: 'sms', to_ref: `aide:${r.aide.id}`,
    body: `Open shift: ${fmt(shift.starts_at, tz)} to ${new Date(shift.ends_at).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })} (${shift.service_code}), client ${initials(client.first_name, client.last_name)} in your area${r.distanceMiles != null ? ` (~${r.distanceMiles.toFixed(0)} mi)` : ''}. Reply YES to take it, NO to pass.`,
    payload: { effect: 'shift_offer_sent', shift_id: shift.id, aide_id: r.aide.id, client_id: client.id, shift_starts_at: new Date(shift.starts_at).toISOString(), to_label: who, about: `Client ${initials(client.first_name, client.last_name)}` },
    dedupe_key: `shift:${shift.id}:offer:${r.aide.id}`,
    // an offer is worthless once the shift has started
    expires_at: new Date(shift.starts_at),
  }
}

export function buildSchedulerAlert(shift: ShiftRow, client: ClientRow, tz: string, offers: number): Proposal {
  return {
    kind: 'email', to_ref: 'scheduler',
    subject: `Still open: ${fmt(shift.starts_at, tz)} · client ${initials(client.first_name, client.last_name)}`,
    body: `The ${shift.service_code} shift at ${fmt(shift.starts_at, tz)} for client ${initials(client.first_name, client.last_name)} is still open 30 minutes before start after ${offers} offer(s). Please call the family and the backup list now.`,
    payload: { shift_id: shift.id, client_id: client.id, to_label: 'Scheduler', about: `Client ${initials(client.first_name, client.last_name)}` },
    dedupe_key: `shift:${shift.id}:still-open`,
  }
}

export function buildFamilyConfirmation(shift: ShiftRow, client: ClientRow, aide: { id: string; first_name: string; last_name: string }, tz: string): Proposal {
  return {
    kind: 'sms', to_ref: `family:${client.id}`,
    body: `Confirmed: ${aide.first_name} ${initials(null, aide.last_name)} will cover the visit on ${fmt(shift.starts_at, tz)}. Reply to this number with any questions.`,
    payload: { shift_id: shift.id, client_id: client.id, aide_id: aide.id, to_label: `Family of client ${initials(client.first_name, client.last_name)}` },
    dedupe_key: `shift:${shift.id}:family-confirm`,
  }
}

export const openShiftFill: WorkerDef = {
  name: 'open_shift_fill', nightly: true,
  async propose(db: Db, agency: AgencyRow, now: Date) {
    const proposals: Proposal[] = []
    const shifts = await db.query<ShiftRow>("select id, client_id, service_code, starts_at, ends_at, status, open_since from shifts where agency_id = $1 and status = 'open' and starts_at > $2 order by starts_at", [agency.id, now.toISOString()])
    if (!shifts.length) return proposals
    const aides = await db.query<AideRow>('select id, first_name, last_name, phone, services, active, lat, lng, declined_client_ids, quit_risk from aides where agency_id = $1', [agency.id])
    const busy = await db.query<BusyWindow>("select aide_id, starts_at, ends_at from shifts where agency_id = $1 and aide_id is not null and status in ('scheduled','filled') and ends_at > $2", [agency.id, now.toISOString()])
    for (const shift of shifts) {
      const client = await db.one<ClientRow>('select id, first_name, last_name, lat, lng from clients where id = $1', [shift.client_id])
      if (!client) continue
      const declined = await db.query<{ aide_id: string }>("select aide_id from shift_offers where shift_id = $1 and status = 'declined'", [shift.id])
      const ranked = rankAides(shift, client, aides, busy, agency.radius_miles, { declinedOfferAideIds: declined.map(d => d.aide_id) }).slice(0, 5)
      for (const r of ranked) {
        await db.query("insert into shift_offers (agency_id, shift_id, aide_id, status) values ($1,$2,$3,'pending') on conflict (shift_id, aide_id) do nothing", [agency.id, shift.id, r.aide.id])
        proposals.push(buildOfferProposal(shift, client, r, agency.timezone))
      }
      const minutesToStart = (new Date(shift.starts_at).getTime() - now.getTime()) / 60e3
      if (minutesToStart <= 30) {
        const n = await db.one<{ n: string }>('select count(*)::text as n from shift_offers where shift_id = $1', [shift.id])
        proposals.push(buildSchedulerAlert(shift, client, agency.timezone, Number(n?.n ?? 0)))
      }
    }
    return proposals
  },
}

const lateYes = (shiftId: string, aide: { id: string; first_name: string; last_name: string }): Proposal => ({
  kind: 'sms', to_ref: `aide:${aide.id}`, body: 'Thanks! That shift was just filled. We will text you the next one.',
  payload: { shift_id: shiftId, to_label: `Aide ${initials(aide.first_name, aide.last_name)}` }, dedupe_key: `shift:${shiftId}:late-yes:${aide.id}`,
})

/** Twilio "YES"/"NO" from an aide. Fills the shift exactly once. */
export async function handleAideReply(db: Db, aide: { id: string; agency_id: string; first_name: string; last_name: string }, text: string, tz: string): Promise<{ handled: boolean; filled?: boolean; proposals: Proposal[] }> {
  const yes = /^\s*y(es)?\b/i.test(text)
  const no = /^\s*n(o)?\b/i.test(text)
  if (!yes && !no) return { handled: false, proposals: [] }
  // Latest sent offer first; among unsent ones, the soonest shift. A superseded offer the aide
  // has not answered yet still counts, so a late YES is never applied to a different shift.
  const offer = await db.one<{ id: string; shift_id: string; status: string }>(
    `select o.id, o.shift_id, o.status from shift_offers o join shifts s on s.id = o.shift_id
     where o.aide_id = $1 and o.status in ('sent','pending','superseded') and o.responded_at is null
     order by o.sent_at desc nulls last, s.starts_at asc limit 1 for update of o`, [aide.id])
  if (!offer) return { handled: false, proposals: [] }
  if (offer.status === 'superseded') {
    await db.query("update shift_offers set response = $2, responded_at = now() where id = $1", [offer.id, yes ? 'yes' : 'no'])
    return { handled: true, filled: false, proposals: yes ? [lateYes(offer.shift_id, aide)] : [] }
  }
  if (no) {
    await db.query("update shift_offers set status = 'declined', response = 'no', responded_at = now() where id = $1", [offer.id])
    return { handled: true, filled: false, proposals: [] }
  }
  const shift = await db.one<ShiftRow>("select id, client_id, service_code, starts_at, ends_at, status, open_since from shifts where id = $1 for update", [offer.shift_id])
  if (!shift || shift.status !== 'open') {
    await db.query("update shift_offers set status = 'superseded', response = 'yes', responded_at = now() where id = $1", [offer.id])
    return { handled: true, filled: false, proposals: [lateYes(offer.shift_id, aide)] }
  }
  await db.query("update shifts set status = 'filled', aide_id = $2, filled_at = now() where id = $1", [shift.id, aide.id])
  await db.query("update shift_offers set status = 'accepted', response = 'yes', responded_at = now() where id = $1", [offer.id])
  await db.query("update shift_offers set status = 'superseded' where shift_id = $1 and id <> $2 and status in ('pending','sent')", [shift.id, offer.id])
  // Filled: every other pending offer (proposed / approved / queued) is suppressed, not sent later. The shifts
  // trigger in migration 0023 does the same for fills made from any other code path.
  await suppressShiftOffers(db, aide.agency_id, shift.id, aide.id)
  const client = await db.one<ClientRow>('select id, first_name, last_name, lat, lng from clients where id = $1', [shift.client_id])
  const proposals: Proposal[] = client ? [buildFamilyConfirmation(shift, client, aide, tz)] : []
  proposals.push({ kind: 'sms', to_ref: `aide:${aide.id}`, body: `You're confirmed for ${fmt(shift.starts_at, tz)}. Thank you!`, payload: { shift_id: shift.id, to_label: `Aide ${initials(aide.first_name, aide.last_name)}` }, dedupe_key: `shift:${shift.id}:aide-confirm:${aide.id}` })
  return { handled: true, filled: true, proposals }
}
