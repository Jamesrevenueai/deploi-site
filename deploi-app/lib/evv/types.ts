export type ExceptionRule =
  | 'missing_clock_in'
  | 'missing_clock_out'
  | 'duration_out_of_tolerance'
  | 'gps_outside_geofence'
  | 'unverified_past_window'
  | 'service_auth_mismatch'
  | 'units_exceed_auth'

export type Severity = 'low' | 'medium' | 'high'

export const RULE_LABELS: Record<ExceptionRule, string> = {
  missing_clock_in: 'Missing clock-in',
  missing_clock_out: 'Missing clock-out',
  duration_out_of_tolerance: 'Duration outside tolerance',
  gps_outside_geofence: 'GPS outside geofence',
  unverified_past_window: 'Unverified past correction window',
  service_auth_mismatch: 'Service vs. authorization mismatch',
  units_exceed_auth: 'Units exceed remaining authorization',
}

/** The slice of a visits row the rules need. Dates are Date | null. */
export type RuleVisit = {
  client_id: string | null
  service_code: string
  scheduled_start: Date | null
  scheduled_end: Date | null
  actual_start: Date | null
  actual_end: Date | null
  verification_status: string
  gps_in_flag: boolean | null
  gps_out_flag: boolean | null
  units: number | null
}

export type AuthSlice = {
  client_id: string
  service_code: string
  units_authorized: number
  units_used: number
  starts_on: Date
  ends_on: Date
}

export type RuleContext = {
  /** active authorizations for this client (any service) */
  authorizations: AuthSlice[]
  toleranceMin: number
  windowDays: number
  now: Date
}

export type ExceptionResult = { rule: ExceptionRule; detail: string; severity: Severity }

/** Normalised row from any vendor export, before it becomes a visits row. */
export type VisitInput = {
  vendor_visit_key: string
  client_name: string | null
  client_ref: string | null
  employee_name: string | null
  service_code: string
  scheduled_start: Date | null
  scheduled_end: Date | null
  actual_start: Date | null
  actual_end: Date | null
  verification_status: 'verified' | 'unverified' | 'exception'
  gps_in_flag: boolean | null
  gps_out_flag: boolean | null
  units: number | null
}
