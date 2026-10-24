/**
 * Column mapping for vendor exports. Sandata has a preset; everything else is
 * auto-detected from header synonyms and can be corrected in the import form.
 */
import type { VisitInput } from './types'

export const FIELDS = [
  'vendor_visit_key', 'client_name', 'client_ref', 'employee_name', 'service_code',
  'scheduled_start', 'scheduled_end', 'actual_start', 'actual_end',
  'verification_status', 'gps_in_flag', 'gps_out_flag', 'units',
] as const
export type Field = typeof FIELDS[number]
export type Mapping = Partial<Record<Field, string>>
export const REQUIRED: Field[] = ['vendor_visit_key', 'service_code']

export const FIELD_LABELS: Record<Field, string> = {
  vendor_visit_key: 'Visit key', client_name: 'Client name', client_ref: 'Client ID', employee_name: 'Employee name',
  service_code: 'Service code', scheduled_start: 'Scheduled start', scheduled_end: 'Scheduled end',
  actual_start: 'Actual start (clock-in)', actual_end: 'Actual end (clock-out)', verification_status: 'Verification status',
  gps_in_flag: 'GPS in flag', gps_out_flag: 'GPS out flag', units: 'Units',
}

const SYNONYMS: Record<Field, string[]> = {
  vendor_visit_key: ['visitkey', 'visit key', 'visit_key', 'visit id', 'visitid', 'visit_id', 'key', 'id'],
  client_name: ['clientname', 'client name', 'client', 'patient', 'patient name', 'member', 'member name', 'recipient', 'recipient name'],
  client_ref: ['clientid', 'client id', 'client_id', 'patient id', 'member id', 'medicaid id', 'recipient id'],
  employee_name: ['employeename', 'employee name', 'employee', 'caregiver', 'caregiver name', 'aide', 'aide name', 'worker', 'staff'],
  service_code: ['service', 'service code', 'servicecode', 'procedure', 'procedure code', 'hcpcs'],
  scheduled_start: ['schedulestarttime', 'scheduled start', 'schedule start', 'sched start', 'scheduled_start', 'planned start', 'start scheduled'],
  scheduled_end: ['scheduleendtime', 'scheduled end', 'schedule end', 'sched end', 'scheduled_end', 'planned end', 'end scheduled'],
  actual_start: ['callintime', 'call in time', 'call-in', 'clock in', 'clock-in', 'clockin', 'actual start', 'actual_start', 'check in', 'visit start', 'start time'],
  actual_end: ['callouttime', 'call out time', 'call-out', 'clock out', 'clock-out', 'clockout', 'actual end', 'actual_end', 'check out', 'visit end', 'end time'],
  verification_status: ['visitstatus', 'visit status', 'verification status', 'verification', 'status', 'evv status', 'verified'],
  gps_in_flag: ['callingps', 'call in gps', 'gps in', 'gps_in', 'clock in gps', 'gps in geofence', 'geofence in'],
  gps_out_flag: ['calloutgps', 'call out gps', 'gps out', 'gps_out', 'clock out gps', 'gps out geofence', 'geofence out'],
  units: ['units', 'billable units', 'unit count'],
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Sandata visit export header names, as they appear in a Visit Maintenance export. */
export const SANDATA_PRESET: Mapping = {
  vendor_visit_key: 'VisitKey', client_name: 'ClientName', client_ref: 'ClientID', employee_name: 'EmployeeName',
  service_code: 'Service', scheduled_start: 'ScheduleStartTime', scheduled_end: 'ScheduleEndTime',
  actual_start: 'CallInTime', actual_end: 'CallOutTime', verification_status: 'VisitStatus',
  gps_in_flag: 'CallInGPS', gps_out_flag: 'CallOutGPS', units: 'Units',
}

export function detectMapping(headers: string[], preset?: Mapping): Mapping {
  const m: Mapping = {}
  const hn = headers.map(h => ({ h, n: norm(h) }))
  if (preset) for (const f of FIELDS) { const want = preset[f]; if (want && headers.includes(want)) m[f] = want }
  for (const f of FIELDS) {
    if (m[f]) continue
    const syns = SYNONYMS[f].map(norm)
    const exact = hn.find(x => syns.includes(x.n) && !Object.values(m).includes(x.h))
    if (exact) { m[f] = exact.h; continue }
    const partial = hn.find(x => syns.some(s => s.length > 3 && x.n.includes(s)) && !Object.values(m).includes(x.h))
    if (partial) m[f] = partial.h
  }
  return m
}

export function missingRequired(m: Mapping): Field[] { return REQUIRED.filter(f => !m[f]) }

// ---------------------------------------------------------------- value parsing
const DT_FORMATS = [
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/,           // ISO-ish
  /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i, // US
]
export function parseDateTime(v: string | null | undefined, tz = 'America/New_York'): Date | null {
  if (!v) return null
  const s = String(v).trim()
  if (!s) return null
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) { const d = new Date(s); return isNaN(d.getTime()) ? null : d }
  let y: number, mo: number, d: number, h: number, mi: number, sec = 0
  let m = s.match(DT_FORMATS[0])
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; h = +m[4]; mi = +m[5]; sec = +(m[6] ?? 0) }
  else {
    m = s.match(DT_FORMATS[1])
    if (!m) { const g = new Date(s); return isNaN(g.getTime()) ? null : g }
    mo = +m[1]; d = +m[2]; y = +m[3]; h = +m[4]; mi = +m[5]; sec = +(m[6] ?? 0)
    const ap = m[7]?.toUpperCase()
    if (ap === 'PM' && h < 12) h += 12
    if (ap === 'AM' && h === 12) h = 0
  }
  // interpret as wall-clock time in the agency timezone
  const guess = Date.UTC(y, mo - 1, d, h, mi, sec)
  const offset = tzOffsetMs(new Date(guess), tz)
  return new Date(guess - offset)
}
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - at.getTime()
}

export function parseFlag(v: string | null | undefined): boolean | null {
  if (v == null) return null
  const s = String(v).trim().toLowerCase()
  if (!s) return null
  if (['y', 'yes', 'true', '1', 'in', 'pass', 'ok', 'within', 'match', 'verified'].includes(s)) return true
  if (['n', 'no', 'false', '0', 'out', 'fail', 'outside', 'mismatch'].includes(s)) return false
  if (['missing', 'none', 'na', 'n/a', 'null', 'unknown'].includes(s)) return null
  return null
}

export function parseStatus(v: string | null | undefined): VisitInput['verification_status'] {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return 'unverified'
  if (s.startsWith('verif') || s === 'complete' || s === 'completed' || s === 'approved' || s === 'processed') return 'verified'
  if (s.includes('exception') || s.includes('incomplete') || s.includes('omit') || s.includes('reject')) return 'exception'
  return 'unverified'
}

export type UnitRule = { unitMinutes: number; rounding: 'nearest' | 'down' | 'up' }
export const DEFAULT_UNIT_RULE: UnitRule = { unitMinutes: 15, rounding: 'nearest' }

/** Minutes -> billable units with the rule set's unit length and rounding mode. Non-positive durations give 0. */
export function toUnits(minutes: number, unitMinutes = 15, rounding: UnitRule['rounding'] = 'nearest'): number {
  if (!(minutes > 0) || !(unitMinutes > 0)) return 0
  const raw = minutes / unitMinutes
  if (rounding === 'down') return Math.floor(raw + 1e-9)
  if (rounding === 'up') return Math.ceil(raw - 1e-9)
  return Math.round(raw)
}

export function normalizeRow(row: Record<string, string>, m: Mapping, tz: string, unitRule: UnitRule = DEFAULT_UNIT_RULE): VisitInput | null {
  const get = (f: Field) => { const h = m[f]; return h ? (row[h] ?? '').toString().trim() : '' }
  const key = get('vendor_visit_key')
  const service = get('service_code').toUpperCase()
  if (!key || !service) return null
  const scheduled_start = parseDateTime(get('scheduled_start'), tz)
  const scheduled_end = parseDateTime(get('scheduled_end'), tz)
  const actual_start = parseDateTime(get('actual_start'), tz)
  const actual_end = parseDateTime(get('actual_end'), tz)
  const unitsRaw = get('units')
  let units: number | null = unitsRaw ? Number(unitsRaw) : null
  let units_derived = false
  if (units == null || Number.isNaN(units)) {
    // Never fabricate delivered service: units come from the file, else from a recorded clock-in AND clock-out. Not from the schedule.
    const a = actual_start && actual_end ? (actual_end.getTime() - actual_start.getTime()) / 60_000 : null
    units = a != null && a > 0 ? toUnits(a, unitRule.unitMinutes, unitRule.rounding) : null
    units_derived = units != null
  }
  return {
    vendor_visit_key: key,
    client_name: get('client_name') || null,
    client_ref: get('client_ref') || null,
    employee_name: get('employee_name') || null,
    service_code: service,
    scheduled_start, scheduled_end, actual_start, actual_end,
    verification_status: parseStatus(get('verification_status')),
    gps_in_flag: parseFlag(get('gps_in_flag')),
    gps_out_flag: parseFlag(get('gps_out_flag')),
    units,
    units_derived,
  }
}
