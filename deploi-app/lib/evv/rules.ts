/**
 * EVV exception rules. Pure functions: a visit + context in, an exception or null out.
 * Each rule has a test in lib/evv/rules.test.ts.
 */
import type { RuleVisit, RuleContext, ExceptionResult, AuthSlice } from './types'
import { toUnits } from './mappers'

const MIN = 60_000
const GRACE_MIN = 60

function minutes(a: Date, b: Date) { return Math.round((b.getTime() - a.getTime()) / MIN) }
function sameDay(d: Date, lo: Date, hi: Date) { return d.getTime() >= lo.getTime() && d.getTime() <= hi.getTime() + 86_400_000 - 1 }

/** authorizations that cover the visit date for this client */
export function activeAuths(v: RuleVisit, ctx: RuleContext): AuthSlice[] {
  const at = v.scheduled_start ?? v.actual_start
  if (!v.client_id || !at) return []
  return ctx.authorizations.filter(a => a.client_id === v.client_id && sameDay(at, a.starts_on, a.ends_on))
}

export function missingClockIn(v: RuleVisit, ctx: RuleContext): ExceptionResult | null {
  if (v.actual_start) return null
  if (!v.scheduled_start || v.scheduled_start.getTime() > ctx.now.getTime()) return null
  return { rule: 'missing_clock_in', detail: 'No clock-in recorded for a visit that was scheduled to start', severity: 'high' }
}

export function missingClockOut(v: RuleVisit, ctx: RuleContext): ExceptionResult | null {
  if (!v.actual_start || v.actual_end) return null
  const due = v.scheduled_end ?? v.actual_start
  if (due.getTime() + GRACE_MIN * MIN > ctx.now.getTime()) return null
  return { rule: 'missing_clock_out', detail: 'Clock-in exists but no clock-out was recorded', severity: 'high' }
}

export function durationOutOfTolerance(v: RuleVisit, ctx: RuleContext): ExceptionResult | null {
  if (!v.actual_start || !v.actual_end || !v.scheduled_start || !v.scheduled_end) return null
  const actual = minutes(v.actual_start, v.actual_end)
  const sched = minutes(v.scheduled_start, v.scheduled_end)
  if (Math.abs(actual - sched) <= ctx.toleranceMin) return null
  return { rule: 'duration_out_of_tolerance', detail: `Actual ${actual} min vs scheduled ${sched} min (tolerance ±${ctx.toleranceMin})`, severity: 'medium' }
}

export function gpsOutsideGeofence(v: RuleVisit): ExceptionResult | null {
  const problems: string[] = []
  let severity: 'low' | 'medium' = 'low'
  if (v.actual_start && v.gps_in_flag !== true) { problems.push(v.gps_in_flag === false ? 'clock-in outside geofence' : 'clock-in GPS missing'); if (v.gps_in_flag === false) severity = 'medium' }
  if (v.actual_end && v.gps_out_flag !== true) { problems.push(v.gps_out_flag === false ? 'clock-out outside geofence' : 'clock-out GPS missing'); if (v.gps_out_flag === false) severity = 'medium' }
  if (!problems.length) return null
  return { rule: 'gps_outside_geofence', detail: problems.join('; '), severity }
}

export function unverifiedPastWindow(v: RuleVisit, ctx: RuleContext): ExceptionResult | null {
  if (v.verification_status !== 'unverified') return null
  if (ctx.windowDays == null) return null // no configured window: nothing to be past
  const at = v.scheduled_start ?? v.actual_start
  if (!at) return null
  const ageDays = (ctx.now.getTime() - at.getTime()) / 86_400_000
  if (ageDays <= ctx.windowDays) return null
  return { rule: 'unverified_past_window', detail: `Still unverified ${Math.floor(ageDays)} days after the visit; the ${ctx.windowDays}-day correction window has closed`, severity: 'high' }
}

export function serviceAuthMismatch(v: RuleVisit, ctx: RuleContext): ExceptionResult | null {
  if (!v.client_id) return null
  const auths = activeAuths(v, ctx)
  if (auths.length === 0) return { rule: 'service_auth_mismatch', detail: `No active authorization on file for this client on the visit date (billed ${v.service_code})`, severity: 'high' }
  if (auths.some(a => a.service_code === v.service_code)) return null
  return { rule: 'service_auth_mismatch', detail: `Visit billed ${v.service_code}; active authorization covers ${auths.map(a => a.service_code).join(', ')}`, severity: 'high' }
}

/** Units for the authorization check: the file's units, else derived from recorded clock times with the rule set. */
export function visitUnits(v: RuleVisit, ctx: RuleContext): number | null {
  if (v.units != null) return v.units
  if (!v.actual_start || !v.actual_end) return null
  return toUnits(minutes(v.actual_start, v.actual_end), ctx.unitMinutes, ctx.unitRounding)
}

export function unitsExceedAuth(v: RuleVisit, ctx: RuleContext): ExceptionResult | null {
  if (!v.client_id) return null
  const units = visitUnits(v, ctx)
  if (units == null) return null
  const auth = activeAuths(v, ctx).find(a => a.service_code === v.service_code)
  if (!auth) return null
  const remaining = auth.units_authorized - auth.units_used
  if (units <= remaining) return null
  return { rule: 'units_exceed_auth', detail: `Visit needs ${units} units (${ctx.unitMinutes}-min units, rounded ${ctx.unitRounding}); only ${Math.max(0, remaining)} remain on the ${auth.service_code} authorization`, severity: 'high' }
}

export const RULES = [missingClockIn, missingClockOut, durationOutOfTolerance, gpsOutsideGeofence, unverifiedPastWindow, serviceAuthMismatch, unitsExceedAuth] as const

export function deriveExceptions(v: RuleVisit, ctx: RuleContext): ExceptionResult[] {
  const out: ExceptionResult[] = []
  for (const rule of RULES) {
    const r = rule(v, ctx)
    if (r) out.push(r)
  }
  return out
}
