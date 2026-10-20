import { describe, it, expect } from 'vitest'
import { flagAuthorizations, daysBetween } from '../../workers/authorization_watch'
import { credentialExpiries } from '../../workers/credential_tracking'
import { rankAides, overlaps, type ShiftRow, type ClientRow, type AideRow } from '../../workers/open_shift_fill'
import { decideCapacity, templateReply } from '../../workers/referral_response'
import { nextScreenState, scoreAnswers, nextInterviewSlot } from '../../workers/applicant_screening'
import { checkinsDue, quitRisk } from '../../workers/retention_checkins'
import { haversineMiles } from '../../lib/workers/geo'
import { initials } from '../../lib/workers/types'

const NOW = new Date('2026-10-20T12:00:00Z')
const ymd = (d: number) => new Date(NOW.getTime() + d * 86400e3).toISOString().slice(0, 10)

describe('authorization_watch', () => {
  it('flags ≤15% remaining and ≤30-day expiry, nothing else', () => {
    const f = flagAuthorizations([
      { id: 'a', client_id: 'c', service_code: 'T1019', units_authorized: 1000, units_used: 860, ends_on: ymd(100) },
      { id: 'b', client_id: 'c', service_code: 'T1019', units_authorized: 1000, units_used: 200, ends_on: ymd(29) },
      { id: 'c', client_id: 'c', service_code: 'T1019', units_authorized: 1000, units_used: 200, ends_on: ymd(31) },
      { id: 'd', client_id: 'c', service_code: 'T1019', units_authorized: 1000, units_used: 849, ends_on: ymd(100) },
    ], NOW)
    expect(f.map(x => x.auth.id)).toEqual(['a', 'b'])
    expect(f[0].reasons).toEqual(['low_units'])
    expect(f[1].reasons).toEqual(['expiring'])
    expect(daysBetween(NOW, ymd(29))).toBe(29)
  })
})

describe('credential_tracking', () => {
  it('buckets expiries into 30/14/7 and ignores lapsed or far-off ones', () => {
    const e = credentialExpiries([{ id: 'x', first_name: 'A', last_name: 'B', phone: null, credentials: [
      { type: 'STNA', expires_on: ymd(5) }, { type: 'CPR', expires_on: ymd(12) }, { type: 'BCI', expires_on: ymd(30) }, { type: 'TB', expires_on: ymd(31) }, { type: 'Old', expires_on: ymd(-1) },
    ] }], NOW)
    expect(e.map(x => [x.cred.type, x.threshold])).toEqual([['STNA', 7], ['CPR', 14], ['BCI', 30]])
  })
})

describe('open_shift_fill ranking', () => {
  const shift: ShiftRow = { id: 's', client_id: 'c', service_code: 'T1019', starts_at: '2026-10-21T13:00:00Z', ends_at: '2026-10-21T16:00:00Z', status: 'open', open_since: null }
  const client: ClientRow = { id: 'c', first_name: 'Pat', last_name: 'Lee', lat: 39.96, lng: -83.0 }
  const base = (id: string, o: Partial<AideRow> = {}): AideRow => ({ id, first_name: id, last_name: 'Z', phone: '+1', services: ['T1019'], active: true, lat: 39.97, lng: -83.01, declined_client_ids: [], ...o })
  it('applies every eligibility rule', () => {
    const aides = [
      base('near'),
      base('far', { lat: 40.5, lng: -83.0 }),
      base('inactive', { active: false }),
      base('wrong-service', { services: ['T2025'] }),
      base('declined-client', { declined_client_ids: ['c'] }),
      base('busy'),
      base('declined-offer'),
      base('no-geo', { lat: null, lng: null }),
    ]
    const busy = [{ aide_id: 'busy', starts_at: '2026-10-21T14:00:00Z', ends_at: '2026-10-21T15:00:00Z' }]
    const r = rankAides(shift, client, aides, busy, 25, { declinedOfferAideIds: ['declined-offer'] })
    expect(r.map(x => x.aide.id)).toEqual(['near', 'no-geo'])
    expect(r[0].distanceMiles).toBeLessThan(2)
  })
  it('sorts by distance and caps at five', () => {
    const aides = Array.from({ length: 8 }, (_, i) => base(`a${i}`, { lat: 39.96 + i * 0.01 }))
    const top = rankAides(shift, client, aides, [], 50).slice(0, 5)
    expect(top.length).toBe(5)
    expect(top.map(t => t.aide.id)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4'])
  })
  it('overlap and haversine helpers', () => {
    expect(overlaps('2026-01-01T10:00Z', '2026-01-01T12:00Z', '2026-01-01T11:00Z', '2026-01-01T13:00Z')).toBe(true)
    expect(overlaps('2026-01-01T10:00Z', '2026-01-01T12:00Z', '2026-01-01T12:00Z', '2026-01-01T13:00Z')).toBe(false)
    expect(haversineMiles(39.96, -83.0, 39.96, -83.0)).toBe(0)
    expect(Math.round(haversineMiles(39.9612, -82.9988, 41.4993, -81.6944))).toBeGreaterThan(120)
  })
})

describe('referral_response capacity', () => {
  const rules = { counties: ['Franklin', 'Delaware'], services: ['T1019'], hours: { start: '07:00', end: '20:00' } }
  it('accepts in-rule referrals and declines county/service misses', () => {
    expect(decideCapacity(rules, { county: 'franklin', service: 'T1019' }).canServe).toBe(true)
    expect(decideCapacity(rules, { county: 'Ross', service: 'T1019' })).toEqual({ canServe: false, reasons: ['county Ross not served'] })
    expect(decideCapacity(rules, { county: 'Franklin', service: 'T2025' }).canServe).toBe(false)
  })
  it('outside-hours is a note, not a decline', () => {
    const d = decideCapacity(rules, { county: 'Franklin', service: 'T1019', received_at: '2026-10-20T03:30:00Z' })
    expect(d.canServe).toBe(true)
    expect(d.reasons[0]).toMatch(/outside intake hours/)
  })
  it('template reply never leaks a client name', () => {
    const t = templateReply({ referrerName: 'M. C.', service: 'T1019', county: 'Franklin', canServe: true, agencyName: 'Buckeye' })
    expect(t).toMatch(/starting intake today/)
    expect(t).toMatch(/Buckeye$/)
  })
})

describe('applicant_screening', () => {
  it('walks the 4-question state machine and scores', () => {
    let s = nextScreenState('q1', {}, 'Yes I do')
    expect(s.state).toBe('q2'); expect(s.answers.stna).toBe(true)
    s = nextScreenState('q2', s.answers, 'nope')
    expect(s.answers.drives).toBe(false)
    s = nextScreenState('q3', s.answers, 'Weekends')
    s = nextScreenState('q4', s.answers, 'Franklin County')
    expect(s.state).toBe('complete'); expect(s.answers.county).toBe('Franklin')
    expect(scoreAnswers(s.answers, ['Franklin'])).toBe(3)
    expect(scoreAnswers(s.answers, ['Ross'])).toBe(2)
  })
  it('picks the next interview slot from the agency calendar in local time', () => {
    const slot = nextInterviewSlot([{ weekday: 2, time: '10:00' }, { weekday: 4, time: '14:00' }], NOW, 'America/New_York') // NOW is a Tuesday
    expect(slot).not.toBeNull()
    const local = slot!.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hour12: false })
    expect(local).toMatch(/Thu.*14/)
    expect(nextInterviewSlot([], NOW)).toBeNull()
  })
})

describe('retention_checkins', () => {
  it('finds 30/60/90-day check-ins due in the last week and skips sent ones', () => {
    const aides = [
      { id: 'a', first_name: 'A', last_name: 'B', phone: '+1', hired_on: ymd(-30), quit_risk: false },
      { id: 'b', first_name: 'B', last_name: 'C', phone: '+1', hired_on: ymd(-63), quit_risk: false },
      { id: 'c', first_name: 'C', last_name: 'D', phone: '+1', hired_on: ymd(-100), quit_risk: false },
      { id: 'd', first_name: 'D', last_name: 'E', phone: '+1', hired_on: ymd(-29), quit_risk: false },
    ]
    const due = checkinsDue(aides, NOW, [{ aide_id: 'b', day: 60 }])
    expect(due.map(d => [d.aide.id, d.day])).toEqual([['a', 30]])
  })
  it('quit risk needs 2+ declines and a late clock-in inside 14 days, rule-based', () => {
    const d = (x: number) => new Date(NOW.getTime() - x * 86400e3)
    expect(quitRisk([d(1), d(5)], [d(3)]).flagged).toBe(true)
    expect(quitRisk([d(1)], [d(3)]).flagged).toBe(false)
    expect(quitRisk([d(1), d(20)], [d(3)]).flagged).toBe(false)
    expect(quitRisk([d(1), d(5)], []).flagged).toBe(false)
  })
})

describe('initials', () => {
  it('never exposes a full name', () => { expect(initials('Jordan', 'Okafor')).toBe('J.O.'); expect(initials(null, 'Lee')).toBe('L.') })
})
