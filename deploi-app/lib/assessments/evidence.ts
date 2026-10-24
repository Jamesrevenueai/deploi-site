/**
 * Evidence layer for an assessment (assessments.evidence jsonb). Aggregate and redacted only: nothing here is
 * patient information. Per-input status + source note, the evidence period, sample size, source reference, who
 * supplied the numbers, missing-data indicators, staff notes, and the customer-corrections log.
 */
import { INPUT_KEYS, INPUT_STATUSES, REQUIRED_INPUT_KEYS, DEFAULT_STATUS, type InputKey, type InputStatus, type InputStatuses, type LeakInputs, type Leak } from '../leaks'

export type Correction = { field: string; previous: string; corrected: string; by: string; at: string; note: string | null; recorded_by: string | null }
export type InputEvidence = { status: InputStatus; source: string | null }
export type Evidence = {
  period_start: string | null
  period_end: string | null
  sample_size: number | null
  source_reference: string | null
  supplied_by: string | null
  /** trace step fields were deliberately left blank or aggregated */
  redacted: boolean
  staff_notes: string | null
  inputs: Partial<Record<InputKey, InputEvidence>>
  /** input keys that would change the frequency basis or size a leak but were not supplied */
  missing: string[]
  corrections: Correction[]
}

export const EMPTY_EVIDENCE: Evidence = { period_start: null, period_end: null, sample_size: null, source_reference: null, supplied_by: null, redacted: false, staff_notes: null, inputs: {}, missing: [], corrections: [] }

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const date = (v: unknown) => { const s = str(v); return s && /^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10)) ? s.slice(0, 10) : null }
const int = (v: unknown) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : null }
const isStatus = (v: unknown): v is InputStatus => typeof v === 'string' && (INPUT_STATUSES as string[]).includes(v)

/** Normalise whatever is stored (or nothing) into a full Evidence object. */
export function parseEvidence(raw: unknown): Evidence {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const inputs: Evidence['inputs'] = {}
  const ri = (r.inputs && typeof r.inputs === 'object' ? r.inputs : {}) as Record<string, unknown>
  for (const k of INPUT_KEYS) {
    const e = ri[k] as Record<string, unknown> | undefined
    if (e && isStatus(e.status)) inputs[k] = { status: e.status, source: str(e.source) }
  }
  const corrections = Array.isArray(r.corrections) ? (r.corrections as Record<string, unknown>[]).filter(c => c && typeof c === 'object').map(c => ({
    field: String(c.field ?? ''), previous: String(c.previous ?? ''), corrected: String(c.corrected ?? ''), by: String(c.by ?? ''), at: String(c.at ?? ''), note: str(c.note), recorded_by: str(c.recorded_by),
  })) : []
  return {
    period_start: date(r.period_start), period_end: date(r.period_end), sample_size: int(r.sample_size), source_reference: str(r.source_reference), supplied_by: str(r.supplied_by),
    redacted: r.redacted === true || r.redacted === 'true' || r.redacted === 'on' || r.redacted === '1', staff_notes: str(r.staff_notes), inputs,
    missing: Array.isArray(r.missing) ? (r.missing as unknown[]).filter((x): x is string => typeof x === 'string') : [], corrections,
  }
}

/** Build the evidence from the leak-inputs form: `status_<key>`, `source_<key>` and the evidence panel fields. Corrections are preserved from `existing`. */
export function evidenceFromForm(raw: Record<string, unknown>, existing: Evidence, inputs: LeakInputs): Evidence {
  const ev: Evidence = { ...parseEvidence(raw), corrections: existing.corrections, inputs: {} }
  for (const k of INPUT_KEYS) {
    const status = raw[`status_${k}`]
    const source = str(raw[`source_${k}`])
    if (isStatus(status) || source) ev.inputs[k] = { status: isStatus(status) ? status : DEFAULT_STATUS[k], source }
  }
  ev.missing = missingInputs(inputs)
  return ev
}

export function statusesFromEvidence(ev: Evidence): InputStatuses {
  const out: InputStatuses = {}
  for (const k of INPUT_KEYS) if (ev.inputs[k]) out[k] = ev.inputs[k]!.status
  return out
}

/** Inputs whose absence keeps a leak illustrative or unsized. */
export function missingInputs(i: LeakInputs): string[] {
  const out: string[] = []
  for (const k of REQUIRED_INPUT_KEYS) if (!(Number(i[k]) > 0)) out.push(k)
  if (!(Number(i.period_days) > 0)) out.push('period_days')
  for (const k of ['referrals_in_period', 'claims_in_period', 'denied_claims_in_period', 'open_shifts_in_period', 'billed_revenue_year', 'admin_hours_week', 'admin_hourly_cost'] as InputKey[]) if (i[k] == null) out.push(k)
  return out
}

/** Counts of inputs used by the given leaks per status, for the evidence-quality section. */
export function provenanceSummary(leaks: Leak[]): Record<InputStatus, string[]> {
  const out: Record<InputStatus, Set<string>> = { measured: new Set(), owner_reported: new Set(), assumed: new Set() }
  for (const l of leaks) for (const [k, s] of Object.entries(l.provenance ?? {})) if (s) out[s].add(k)
  return { measured: [...out.measured], owner_reported: [...out.owner_reported], assumed: [...out.assumed] }
}

export function addCorrectionTo(ev: Evidence, c: Omit<Correction, 'at'> & { at?: string }): Evidence {
  return { ...ev, corrections: [...ev.corrections, { ...c, at: c.at ?? new Date().toISOString() }] }
}

export const INPUT_LABEL: Record<InputKey, string> = {
  avg_monthly_referrals: 'Average monthly referrals', avg_referral_value_year: 'Average referral value per year ($)', aide_turnover_12mo: 'Aides who left in the last 12 months',
  open_shift_hours_week: 'Open-shift hours per week', evv_denial_rate: 'EVV / auth denial rate', period_days: 'Record period (days)', referrals_in_period: 'Referrals in the period',
  claims_in_period: 'Claims in the period', denied_claims_in_period: 'Denied claims in the period', open_shifts_in_period: 'Open shifts in the period', avg_shift_hours: 'Hours per open shift',
  billed_revenue_year: 'Billed revenue per year ($)', admin_hours_week: 'Manual office hours per week', admin_hourly_cost: 'Loaded office cost per hour ($)', recorded_expenditure_change_year: 'Recorded expenditure change per year ($)',
}
