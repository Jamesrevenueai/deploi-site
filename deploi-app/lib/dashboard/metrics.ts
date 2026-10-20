/**
 * The six morning-report numbers plus "needs a human today". Pure SQL over the
 * tenant tables, computed in the agency's timezone. Every read is audited.
 */
import type { Db } from '../db'
import { localDayStart, daysFromNow, localDate, daysUntil } from './time'

export type NeedsHuman = { kind: 'exception' | 'shift' | 'authorization' | 'referral'; title: string; detail: string; href: string }

export type Metrics = {
  agency: { id: string; name: string; timezone: string }
  asOf: string
  referrals: { today: number; week: number; medianMinutes: number | null; unanswered: number }
  shifts: { open: number; filledWeek: number; medianMinutesToFill: number | null; nextOpenStartsAt: string | null }
  exceptions: { open: number; fixedToday: number; openItems: { id: string; rule: string; windowClosesAt: string | null; daysLeft: number | null }[] }
  authorizations: {
    total: number; lowCount: number; lowPct: number; expiring30: number
    rows: { id: string; clientInitials: string; serviceCode: string; used: number; authorized: number; pctLeft: number; endsOn: string }[]
  }
  applicants: { new: number; screened: number; interviewsBooked: number }
  credentials: { lapsing30: number; rows: { aideId: string; aide: string; type: string; expiresOn: string; daysLeft: number }[] }
  needsHuman: NeedsHuman[]
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

export async function getAgency(db: Db, agencyId: string) {
  const g = await db.one<{ id: string; name: string; timezone: string }>('select id, name, timezone from agencies where id = $1', [agencyId])
  if (!g) throw new Error('agency not found')
  return g
}

export async function getMetrics(db: Db, agencyId: string, now = new Date()): Promise<Metrics> {
  const agency = await getAgency(db, agencyId)
  const tz = agency.timezone || 'America/New_York'
  const dayStart = localDayStart(tz, now)
  const weekStart = new Date(dayStart.getTime() - 6 * 86400e3)
  const today = localDate(tz, now)
  const in30 = daysFromNow(tz, now, 30)

  // ---- referrals
  const ref = await db.one<{ today: string; week: string; median_min: string | null; unanswered: string }>(
    `select count(*) filter (where first_response_at >= $2) as today,
            count(*) filter (where first_response_at >= $3) as week,
            percentile_cont(0.5) within group (order by extract(epoch from (first_response_at - received_at)) / 60)
              filter (where first_response_at >= $3) as median_min,
            count(*) filter (where first_response_at is null and status = 'new') as unanswered
     from referrals where agency_id = $1`, [agencyId, dayStart, weekStart])
  await db.auditRead('referrals', agencyId)

  // ---- shifts
  const sh = await db.one<{ open: string; filled_week: string; median_fill: string | null; next_open: string | null }>(
    `select count(*) filter (where status = 'open') as open,
            count(*) filter (where status = 'filled' and filled_at >= $2) as filled_week,
            percentile_cont(0.5) within group (order by extract(epoch from (filled_at - open_since)) / 60)
              filter (where status = 'filled' and filled_at >= $2 and open_since is not null) as median_fill,
            min(starts_at) filter (where status = 'open' and starts_at >= $3) as next_open
     from shifts where agency_id = $1`, [agencyId, weekStart, now])
  await db.auditRead('shifts', agencyId)

  // ---- evv exceptions
  const exOpen = await db.query<{ id: string; rule: string; window_closes_at: string | null }>(
    `select id, rule, window_closes_at from evv_exceptions where agency_id = $1 and status = 'open' order by window_closes_at nulls last`, [agencyId])
  const exFixed = await db.one<{ n: string }>(
    `select count(*) as n from evv_exceptions where agency_id = $1 and status = 'corrected' and corrected_at >= $2`, [agencyId, dayStart])
  await db.auditRead('evv_exceptions', agencyId, exOpen.map(e => e.id))

  // ---- authorizations
  const auths = await db.query<{ id: string; fi: string; li: string; service_code: string; units_used: number; units_authorized: number; ends_on: string }>(
    `select a.id, c.first_name as fi, c.last_name as li, a.service_code, a.units_used, a.units_authorized, a.ends_on::text
     from authorizations a join clients c on c.id = a.client_id
     where a.agency_id = $1 and a.ends_on >= $2 order by (a.units_authorized - a.units_used)::float / greatest(a.units_authorized, 1)`, [agencyId, today])
  await db.auditRead('authorizations', agencyId, auths.map(a => a.id))
  const authRows = auths.map(a => ({
    id: a.id, clientInitials: `${(a.fi?.[0] ?? '').toUpperCase()}.${(a.li?.[0] ?? '').toUpperCase()}.`, serviceCode: a.service_code,
    used: a.units_used, authorized: a.units_authorized,
    pctLeft: Math.max(0, Math.round(((a.units_authorized - a.units_used) / Math.max(a.units_authorized, 1)) * 100)), endsOn: a.ends_on,
  }))
  const lowCount = authRows.filter(a => a.pctLeft <= 15).length
  const expiring30 = authRows.filter(a => a.endsOn <= in30).length

  // ---- applicants
  const ap = await db.one<{ n_new: string; screened: string; booked: string }>(
    `select count(*) filter (where status = 'new') as n_new, count(*) filter (where status = 'screened') as screened,
            count(*) filter (where status = 'interview_booked') as booked from applicants where agency_id = $1`, [agencyId])
  await db.auditRead('applicants', agencyId)

  // ---- credentials
  const creds = await db.query<{ aide_id: string; first_name: string; last_name: string; type: string; expires_on: string }>(
    `select a.id as aide_id, a.first_name, a.last_name, c->>'type' as type, c->>'expires_on' as expires_on
     from aides a, jsonb_array_elements(a.credentials) c
     where a.agency_id = $1 and a.active and (c->>'expires_on')::date between $2::date and $3::date
     order by c->>'expires_on'`, [agencyId, today, in30])
  await db.auditRead('aides', agencyId, [...new Set(creds.map(c => c.aide_id))])
  const credRows = creds.map(c => ({ aideId: c.aide_id, aide: `${c.first_name} ${c.last_name[0]}.`, type: c.type, expiresOn: c.expires_on, daysLeft: daysUntil(c.expires_on + 'T23:59:59Z', now) ?? 0 }))

  const openItems = exOpen.map(e => ({ id: e.id, rule: e.rule, windowClosesAt: e.window_closes_at, daysLeft: daysUntil(e.window_closes_at, now) }))

  // ---- needs a human today (rule-based)
  const needsHuman: NeedsHuman[] = []
  const soonestEx = openItems[0]
  if (soonestEx) needsHuman.push({ kind: 'exception', title: 'EVV exception closing soonest', detail: `${soonestEx.rule.replace(/_/g, ' ')} · ${soonestEx.daysLeft ?? '?'} days left in the correction window`, href: '/app/evv' })
  if (sh?.next_open) needsHuman.push({ kind: 'shift', title: 'Open shift starting soonest', detail: `Starts ${new Date(sh.next_open).toLocaleString('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' })} and has no aide yet`, href: '/app/shifts' })
  const lowest = authRows[0]
  if (lowest && lowest.pctLeft <= 15) needsHuman.push({ kind: 'authorization', title: 'Authorization almost used up', detail: `Client ${lowest.clientInitials} ${lowest.serviceCode}: ${lowest.pctLeft}% of units left, ends ${lowest.endsOn}`, href: '/app/authorizations' })
  if (needsHuman.length < 3 && n(ref?.unanswered) > 0) needsHuman.push({ kind: 'referral', title: 'Referral waiting for a first response', detail: `${n(ref?.unanswered)} new referral${n(ref?.unanswered) === 1 ? '' : 's'} with no response yet`, href: '/app/referrals' })

  return {
    agency, asOf: now.toISOString(),
    referrals: { today: n(ref?.today), week: n(ref?.week), medianMinutes: num(ref?.median_min) === null ? null : Math.round(num(ref?.median_min)!), unanswered: n(ref?.unanswered) },
    shifts: { open: n(sh?.open), filledWeek: n(sh?.filled_week), medianMinutesToFill: num(sh?.median_fill) === null ? null : Math.round(num(sh?.median_fill)!), nextOpenStartsAt: sh?.next_open ? new Date(sh.next_open).toISOString() : null },
    exceptions: { open: openItems.length, fixedToday: n(exFixed?.n), openItems },
    authorizations: { total: authRows.length, lowCount, lowPct: authRows.length ? Math.round((lowCount / authRows.length) * 100) : 0, expiring30, rows: authRows },
    applicants: { new: n(ap?.n_new), screened: n(ap?.screened), interviewsBooked: n(ap?.booked) },
    credentials: { lapsing30: credRows.length, rows: credRows },
    needsHuman: needsHuman.slice(0, 3),
  }
}
