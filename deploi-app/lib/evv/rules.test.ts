import { describe, it, expect } from 'vitest'
import { missingClockIn, missingClockOut, durationOutOfTolerance, gpsOutsideGeofence, unverifiedPastWindow, serviceAuthMismatch, unitsExceedAuth, deriveExceptions } from './rules'
import type { RuleVisit, RuleContext } from './types'

const now = new Date('2026-10-20T12:00:00Z')
const d = (s: string) => new Date(s)
const base: RuleVisit = {
  client_id: 'c1', service_code: 'T1019',
  scheduled_start: d('2026-10-15T12:00:00Z'), scheduled_end: d('2026-10-15T14:00:00Z'),
  actual_start: d('2026-10-15T12:01:00Z'), actual_end: d('2026-10-15T14:02:00Z'),
  verification_status: 'verified', gps_in_flag: true, gps_out_flag: true, units: 8,
}
const ctx: RuleContext = {
  authorizations: [{ client_id: 'c1', service_code: 'T1019', units_authorized: 100, units_used: 90, starts_on: d('2026-10-01T00:00:00Z'), ends_on: d('2026-12-31T00:00:00Z') }],
  toleranceMin: 15, windowDays: 60, now,
}

describe('EVV rules', () => {
  it('clean visit fires nothing', () => { expect(deriveExceptions(base, ctx)).toEqual([]) })

  it('missing_clock_in: no actual_start after the scheduled start', () => {
    expect(missingClockIn({ ...base, actual_start: null, actual_end: null }, ctx)?.rule).toBe('missing_clock_in')
    expect(missingClockIn({ ...base, actual_start: null, scheduled_start: d('2026-11-01T00:00:00Z') }, ctx)).toBeNull()
  })

  it('missing_clock_out: clock-in but no clock-out past the scheduled end + grace', () => {
    expect(missingClockOut({ ...base, actual_end: null }, ctx)?.rule).toBe('missing_clock_out')
    expect(missingClockOut({ ...base, actual_end: null, scheduled_end: new Date(now.getTime() - 10 * 60000) }, ctx)).toBeNull()
    expect(missingClockOut({ ...base, actual_start: null, actual_end: null }, ctx)).toBeNull()
  })

  it('duration_out_of_tolerance: actual vs scheduled beyond ± tolerance', () => {
    const r = durationOutOfTolerance({ ...base, actual_end: d('2026-10-15T13:00:00Z') }, ctx)
    expect(r?.rule).toBe('duration_out_of_tolerance')
    expect(r?.detail).toContain('59 min vs scheduled 120 min')
    expect(durationOutOfTolerance({ ...base, actual_end: d('2026-10-15T14:10:00Z') }, ctx)).toBeNull()
  })

  it('gps_outside_geofence: false flag is medium, null flag (missing) is low', () => {
    expect(gpsOutsideGeofence({ ...base, gps_in_flag: false })).toMatchObject({ rule: 'gps_outside_geofence', severity: 'medium' })
    expect(gpsOutsideGeofence({ ...base, gps_out_flag: null })).toMatchObject({ rule: 'gps_outside_geofence', severity: 'low' })
    expect(gpsOutsideGeofence({ ...base, actual_end: null, gps_out_flag: null })).toBeNull()
  })

  it('unverified_past_window: unverified and older than the state window', () => {
    const old = { ...base, verification_status: 'unverified', scheduled_start: d('2026-07-01T12:00:00Z'), scheduled_end: d('2026-07-01T14:00:00Z') }
    expect(unverifiedPastWindow(old, ctx)?.rule).toBe('unverified_past_window')
    expect(unverifiedPastWindow(old, { ...ctx, windowDays: 365 })).toBeNull()
    expect(unverifiedPastWindow({ ...base, verification_status: 'unverified' }, ctx)).toBeNull()
  })

  it('service_auth_mismatch: service not covered by an active authorization', () => {
    expect(serviceAuthMismatch({ ...base, service_code: 'S5125' }, ctx)?.rule).toBe('service_auth_mismatch')
    expect(serviceAuthMismatch(base, ctx)).toBeNull()
    expect(serviceAuthMismatch({ ...base, client_id: null }, ctx)).toBeNull()
    expect(serviceAuthMismatch(base, { ...ctx, authorizations: [] })?.detail).toContain('No active authorization')
    const expired = { ...ctx, authorizations: [{ ...ctx.authorizations[0], ends_on: d('2026-10-01T00:00:00Z') }] }
    expect(serviceAuthMismatch(base, expired)?.rule).toBe('service_auth_mismatch')
  })

  it('units_exceed_auth: visit units beyond remaining', () => {
    expect(unitsExceedAuth({ ...base, units: 12 }, ctx)?.rule).toBe('units_exceed_auth')
    expect(unitsExceedAuth({ ...base, units: 10 }, ctx)).toBeNull()
    expect(unitsExceedAuth({ ...base, units: null }, ctx)).toBeNull()
  })

  it('deriveExceptions runs every rule', () => {
    const messy: RuleVisit = { ...base, service_code: 'G0156', actual_end: null, gps_in_flag: false, verification_status: 'unverified' }
    const rules = deriveExceptions(messy, ctx).map(r => r.rule)
    expect(rules).toEqual(['missing_clock_out', 'gps_outside_geofence', 'service_auth_mismatch'])
  })
})
