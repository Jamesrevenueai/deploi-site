/**
 * Leak calculator. Pure functions, no I/O. Every number shown to a client comes
 * from one of these formulas, and the formula text is shown next to the dollars.
 *
 * Phase 7 rework. Every leak carries:
 *  - a category (what kind of money it is; the categories are never summed into one "loss")
 *  - low / base / high with the assumption that drives each bound (`dollars_per_year` = base, for older readers)
 *  - provenance: which inputs were measured / owner-reported / assumed, and the evidence grade derived from them
 *  - an explicit formula string and a calculation explanation
 *  - a frequency basis: broader records (sample n over a period) or illustrative (owner-reported averages only).
 *    The two traces never set a frequency; they corroborate, they do not extrapolate.
 *
 * Rules enforced here (and tested in lib/leaks.test.ts):
 *  - a denied claim is delayed payment until it is unrecoverable; only the unrecovered share is observed loss
 *  - staff time saved is capacity released, never cash, unless an expenditure change is recorded
 *  - the referral leak counts referrals never won; the denial leak is sized from billed revenue supplied as an
 *    input (never re-derived from the referral inputs), so the two cannot claim the same dollar
 *  - turnover is a replacement-cost estimate, shown as such.
 */

export type InputStatus = 'measured' | 'owner_reported' | 'assumed'
export const INPUT_STATUSES: InputStatus[] = ['measured', 'owner_reported', 'assumed']
export const INPUT_STATUS_LABEL: Record<InputStatus, string> = { measured: 'Measured', owner_reported: 'Owner-reported', assumed: 'Assumed' }

export type LeakInputs = {
  /** owner-reported averages (the original five) */
  avg_monthly_referrals: number
  avg_referral_value_year: number
  aide_turnover_12mo: number
  open_shift_hours_week: number
  /** 0–1 */
  evv_denial_rate: number
  /** broader-record inputs; when present the frequency basis is "records", otherwise "illustrative" */
  period_days: number | null
  referrals_in_period: number | null
  claims_in_period: number | null
  denied_claims_in_period: number | null
  open_shifts_in_period: number | null
  avg_shift_hours: number | null
  /** revenue base for the denial leak, from the agency's own billing figure; never derived from referrals */
  billed_revenue_year: number | null
  /** staff capacity */
  admin_hours_week: number | null
  admin_hourly_cost: number | null
  /** cash savings exist only when an expenditure change has actually been recorded */
  recorded_expenditure_change_year: number | null
}
export type InputKey = keyof LeakInputs
export const INPUT_KEYS: InputKey[] = [
  'avg_monthly_referrals', 'avg_referral_value_year', 'aide_turnover_12mo', 'open_shift_hours_week', 'evv_denial_rate',
  'period_days', 'referrals_in_period', 'claims_in_period', 'denied_claims_in_period', 'open_shifts_in_period', 'avg_shift_hours',
  'billed_revenue_year', 'admin_hours_week', 'admin_hourly_cost', 'recorded_expenditure_change_year',
]
/** The five original inputs are required numbers; everything else is optional. */
export const REQUIRED_INPUT_KEYS: InputKey[] = ['avg_monthly_referrals', 'avg_referral_value_year', 'aide_turnover_12mo', 'open_shift_hours_week', 'evv_denial_rate']
export type InputStatuses = Partial<Record<InputKey, InputStatus>>

/** Status used when staff did not pick one: averages are owner-reported, record counts are measured, rates we supply are assumed. */
export const DEFAULT_STATUS: Record<InputKey, InputStatus> = {
  avg_monthly_referrals: 'owner_reported', avg_referral_value_year: 'owner_reported', aide_turnover_12mo: 'owner_reported',
  open_shift_hours_week: 'owner_reported', evv_denial_rate: 'owner_reported',
  period_days: 'measured', referrals_in_period: 'measured', claims_in_period: 'measured', denied_claims_in_period: 'measured',
  open_shifts_in_period: 'measured', avg_shift_hours: 'assumed', billed_revenue_year: 'owner_reported',
  admin_hours_week: 'owner_reported', admin_hourly_cost: 'assumed', recorded_expenditure_change_year: 'measured',
}

export type TraceFacts = {
  /** hours from referral received to first response; null when the trace has no timestamps */
  referral_response_hours: number | null
  /** did the traced visit end denied? */
  visit_denied: boolean | null
  /** was an exception raised and not corrected inside the window? */
  exception_uncorrected: boolean | null
}

export type LeakCategory = 'observed_lost_revenue' | 'potential_revenue_opportunity' | 'delayed_payment' | 'staff_capacity_released' | 'cash_savings' | 'estimated_turnover_replacement_cost'
export const LEAK_CATEGORIES: LeakCategory[] = ['observed_lost_revenue', 'potential_revenue_opportunity', 'delayed_payment', 'staff_capacity_released', 'cash_savings', 'estimated_turnover_replacement_cost']
export const CATEGORY_LABEL: Record<LeakCategory, string> = {
  observed_lost_revenue: 'Observed lost revenue',
  potential_revenue_opportunity: 'Potential revenue opportunity',
  delayed_payment: 'Delayed payment',
  staff_capacity_released: 'Staff capacity released',
  cash_savings: 'Cash savings',
  estimated_turnover_replacement_cost: 'Estimated turnover replacement cost',
}
export const CATEGORY_HELP: Record<LeakCategory, string> = {
  observed_lost_revenue: 'Revenue that was earned or billable and will not be collected.',
  potential_revenue_opportunity: 'Revenue that was never won; an opportunity, not a loss already booked.',
  delayed_payment: 'Money that is late, not lost: denied claims that can still be corrected and rebilled.',
  staff_capacity_released: 'Hours of staff time that a workflow would free. Hours, not cash, unless an expenditure change is recorded.',
  cash_savings: 'An expenditure change that has actually been recorded.',
  estimated_turnover_replacement_cost: 'The cost of replacing staff who left: recruiting, onboarding, training, lost hours. An estimate.',
}

export type EvidenceGrade = 'A' | 'B' | 'C'
export const GRADE_LABEL: Record<EvidenceGrade, string> = { A: 'A · measured', B: 'B · owner-reported', C: 'C · assumed' }

export type FrequencyBasis =
  | { kind: 'records'; sample_size: number; period_days: number; description: string }
  | { kind: 'illustrative'; description: string }

export type LeakKey = 'referral_response' | 'open_shifts' | 'turnover' | 'evv_denials' | 'evv_denials_delayed' | 'staff_capacity' | 'cash_savings'
export type Door = 'growth' | 'staffing' | 'operations'

export type Leak = {
  key: LeakKey
  label: string
  door: Door
  category: LeakCategory
  /** = base, kept for older readers */
  dollars_per_year: number
  low: number
  base: number
  high: number
  /** the assumption that drives each bound */
  assumptions: { low: string; base: string; high: string }
  formula: string
  explanation: string
  inputs: Record<string, number | string | null>
  /** input key -> how it was obtained */
  provenance: Partial<Record<string, InputStatus>>
  grade: EvidenceGrade
  frequency_basis: FrequencyBasis
  illustrative: boolean
  missing_inputs: string[]
}

/** Assumptions, shown on the report so the client can argue with them. */
export const ASSUMPTIONS = {
  /** referrals answered inside this many hours are treated as "on time" */
  on_time_hours: 1,
  /** share of referrals lost per hour of delay past on-time, capped below (low / base / high) */
  lost_share_per_hour: 0.025,
  lost_share_per_hour_low: 0.0125,
  lost_share_per_hour_high: 0.0375,
  lost_share_cap: 0.5,
  /** fallback when the referral trace has no timestamps */
  default_response_hours: 8,
  /** share of open-shift hours that never get filled (low / base / high) */
  unfilled_share: 0.3,
  unfilled_share_low: 0.15,
  unfilled_share_high: 0.45,
  /** billed rate per hour of care (Ohio PASSPORT personal care, rounded) */
  billed_rate_per_hour: 26,
  /** margin share on a billed hour after aide pay and payroll costs */
  margin_share: 0.35,
  /** hours in a typical open shift when the records give a count, not hours */
  default_shift_hours: 4,
  /** fully loaded cost to replace one aide (low / base / high) */
  replacement_cost_per_aide: 2500,
  replacement_cost_low: 1500,
  replacement_cost_high: 4000,
  /** share of denied claims that is never recovered (low / base / high); the rest is delayed, not lost */
  unrecovered_share: 0.5,
  unrecovered_share_low: 0.25,
  unrecovered_share_high: 0.75,
  /** loaded hourly cost of office staff when the agency does not supply one */
  default_admin_hourly_cost: 28,
  /** share of manual hours actually released (low / base / high) */
  released_share_low: 0.5,
  released_share: 1,
  released_share_high: 1.25,
  /** when the frequency is illustrative (no broader records) the low and high bounds are widened by this factor */
  illustrative_widening: 1.5,
}

export const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const round = (n: number) => Math.round(n * 100) / 100
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`
const pos = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

/** A measured input beats an owner-reported one; one assumed input drags the whole leak to C. */
export function gradeFor(provenance: Partial<Record<string, InputStatus>>): EvidenceGrade {
  const v = Object.values(provenance).filter(Boolean) as InputStatus[]
  if (v.length === 0 || v.includes('assumed')) return 'C'
  if (v.includes('owner_reported')) return 'B'
  return 'A'
}

function statusOf(key: InputKey, s: InputStatuses, value: number | null): InputStatus {
  if (value == null) return 'assumed'
  return s[key] ?? DEFAULT_STATUS[key]
}

function widen(low: number, high: number, illustrative: boolean) {
  const w = ASSUMPTIONS.illustrative_widening
  return illustrative ? { low: low / w, high: high * w } : { low, high }
}

const ILLUSTRATIVE_NOTE = 'illustrative (single traced event): no broader records were supplied, so the frequency comes from owner-reported averages only and the bounds are widened'

/** Referrals never won because the first response was slow. Delay from the trace; frequency from records or owner averages. */
export function referralResponseLeak(i: LeakInputs, t: TraceFacts, s: InputStatuses = {}): Leak {
  const records = pos(i.referrals_in_period) && pos(i.period_days)
  const annualReferrals = records ? (i.referrals_in_period! * 365) / i.period_days! : i.avg_monthly_referrals * 12
  const hours = t.referral_response_hours ?? ASSUMPTIONS.default_response_hours
  const lost = (rate: number) => Math.min(ASSUMPTIONS.lost_share_cap, Math.max(0, hours - ASSUMPTIONS.on_time_hours) * rate)
  const book = annualReferrals * i.avg_referral_value_year
  const base = book * lost(ASSUMPTIONS.lost_share_per_hour)
  const { low, high } = widen(book * lost(ASSUMPTIONS.lost_share_per_hour_low), book * lost(ASSUMPTIONS.lost_share_per_hour_high), !records)
  const provenance: Partial<Record<string, InputStatus>> = records
    ? { referrals_in_period: statusOf('referrals_in_period', s, i.referrals_in_period), period_days: statusOf('period_days', s, i.period_days) }
    : { avg_monthly_referrals: statusOf('avg_monthly_referrals', s, i.avg_monthly_referrals) }
  provenance.avg_referral_value_year = statusOf('avg_referral_value_year', s, i.avg_referral_value_year)
  provenance.referral_response_hours = t.referral_response_hours == null ? 'assumed' : 'measured'
  const freqText = records ? `${i.referrals_in_period} referrals in ${i.period_days} days of records → ${round(annualReferrals)}/yr` : `${i.avg_monthly_referrals} referrals/mo (owner-reported) × 12`
  return {
    key: 'referral_response', label: 'Referrals lost to slow response', door: 'growth', category: 'potential_revenue_opportunity',
    dollars_per_year: base, low, base, high,
    assumptions: {
      low: `${pct(ASSUMPTIONS.lost_share_per_hour_low)} of referrals lost per hour of delay${records ? '' : ', widened ÷' + ASSUMPTIONS.illustrative_widening}`,
      base: `${pct(ASSUMPTIONS.lost_share_per_hour)} of referrals lost per hour of delay past ${ASSUMPTIONS.on_time_hours} h, capped at ${pct(ASSUMPTIONS.lost_share_cap)}`,
      high: `${pct(ASSUMPTIONS.lost_share_per_hour_high)} of referrals lost per hour of delay${records ? '' : ', widened ×' + ASSUMPTIONS.illustrative_widening}`,
    },
    formula: `${freqText} × ${money(i.avg_referral_value_year)}/yr per referral × ${pct(lost(ASSUMPTIONS.lost_share_per_hour))} lost (${round(hours)} h to first response${t.referral_response_hours == null ? ', assumed' : ', from the trace'}). Non-overlap: these referrals were never won, so none of this revenue is inside the billed revenue the denial leak uses.`,
    explanation: `Each hour a referral waits past the first hour, a share of referrals goes to the agency that answered first. The share is an assumption the owner can argue with; the delay is the one we traced; the number of referrals is ${records ? 'from the records supplied' : 'the owner-reported average'}.`,
    inputs: { annual_referrals: round(annualReferrals), avg_referral_value_year: i.avg_referral_value_year, response_hours: round(hours), lost_share: round(lost(ASSUMPTIONS.lost_share_per_hour)), source: t.referral_response_hours == null ? 'assumed' : 'trace' },
    provenance, grade: gradeFor(provenance),
    frequency_basis: records ? { kind: 'records', sample_size: i.referrals_in_period!, period_days: i.period_days!, description: `n = ${i.referrals_in_period} referrals over ${i.period_days} days` } : { kind: 'illustrative', description: ILLUSTRATIVE_NOTE },
    illustrative: !records, missing_inputs: records ? [] : ['referrals_in_period', 'period_days'],
  }
}

/** Margin on open-shift hours that never get filled. These hours were never billed, so they are outside billed revenue. */
export function openShiftLeak(i: LeakInputs, s: InputStatuses = {}): Leak {
  const records = pos(i.open_shifts_in_period) && pos(i.period_days)
  const shiftHours = pos(i.avg_shift_hours) ? i.avg_shift_hours! : ASSUMPTIONS.default_shift_hours
  const hoursYear = records ? (i.open_shifts_in_period! * 365 / i.period_days!) * shiftHours : i.open_shift_hours_week * 52
  const marginPerHour = ASSUMPTIONS.billed_rate_per_hour * ASSUMPTIONS.margin_share
  const base = hoursYear * ASSUMPTIONS.unfilled_share * marginPerHour
  const { low, high } = widen(hoursYear * ASSUMPTIONS.unfilled_share_low * marginPerHour, hoursYear * ASSUMPTIONS.unfilled_share_high * marginPerHour, !records)
  const provenance: Partial<Record<string, InputStatus>> = records
    ? { open_shifts_in_period: statusOf('open_shifts_in_period', s, i.open_shifts_in_period), period_days: statusOf('period_days', s, i.period_days), avg_shift_hours: pos(i.avg_shift_hours) ? statusOf('avg_shift_hours', s, i.avg_shift_hours) : 'assumed' }
    : { open_shift_hours_week: statusOf('open_shift_hours_week', s, i.open_shift_hours_week) }
  const freqText = records ? `${i.open_shifts_in_period} open shifts in ${i.period_days} days × ${shiftHours} h → ${round(hoursYear)} h/yr` : `${i.open_shift_hours_week} open h/wk (owner-reported) × 52`
  return {
    key: 'open_shifts', label: 'Open shifts never filled', door: 'operations', category: 'observed_lost_revenue',
    dollars_per_year: base, low, base, high,
    assumptions: {
      low: `${pct(ASSUMPTIONS.unfilled_share_low)} of open hours never filled${records ? '' : ', widened ÷' + ASSUMPTIONS.illustrative_widening}`,
      base: `${pct(ASSUMPTIONS.unfilled_share)} of open hours never filled, $${ASSUMPTIONS.billed_rate_per_hour}/h billed, ${pct(ASSUMPTIONS.margin_share)} margin`,
      high: `${pct(ASSUMPTIONS.unfilled_share_high)} of open hours never filled${records ? '' : ', widened ×' + ASSUMPTIONS.illustrative_widening}`,
    },
    formula: `${freqText} × ${pct(ASSUMPTIONS.unfilled_share)} unfilled × $${ASSUMPTIONS.billed_rate_per_hour}/h × ${pct(ASSUMPTIONS.margin_share)} margin. Non-overlap: unfilled hours were never billed, so they are not inside the billed revenue the denial leak uses.`,
    explanation: 'An open shift that nobody picks up is a visit that was authorized and never delivered. We count the margin on those hours, not the whole billed amount, because the aide was not paid either.',
    inputs: { hours_per_year: round(hoursYear), unfilled_share: ASSUMPTIONS.unfilled_share, billed_rate: ASSUMPTIONS.billed_rate_per_hour, margin_share: ASSUMPTIONS.margin_share },
    provenance, grade: gradeFor(provenance),
    frequency_basis: records ? { kind: 'records', sample_size: i.open_shifts_in_period!, period_days: i.period_days!, description: `n = ${i.open_shifts_in_period} open shifts over ${i.period_days} days` } : { kind: 'illustrative', description: ILLUSTRATIVE_NOTE },
    illustrative: !records, missing_inputs: records ? [] : ['open_shifts_in_period', 'period_days'],
  }
}

/** Replacement cost of aides who left in the last 12 months. An estimate, labelled as such. */
export function turnoverLeak(i: LeakInputs, s: InputStatuses = {}): Leak {
  const n = i.aide_turnover_12mo
  const provenance: Partial<Record<string, InputStatus>> = { aide_turnover_12mo: statusOf('aide_turnover_12mo', s, n) }
  return {
    key: 'turnover', label: 'Aide turnover', door: 'staffing', category: 'estimated_turnover_replacement_cost',
    dollars_per_year: n * ASSUMPTIONS.replacement_cost_per_aide, low: n * ASSUMPTIONS.replacement_cost_low, base: n * ASSUMPTIONS.replacement_cost_per_aide, high: n * ASSUMPTIONS.replacement_cost_high,
    assumptions: { low: `${money(ASSUMPTIONS.replacement_cost_low)} to replace an aide (recruiting and onboarding only)`, base: `${money(ASSUMPTIONS.replacement_cost_per_aide)} to replace an aide (recruiting, onboarding, training, lost hours)`, high: `${money(ASSUMPTIONS.replacement_cost_high)} to replace an aide (including overtime to cover the gap)` },
    formula: `${n} aides left in 12 months × ${money(ASSUMPTIONS.replacement_cost_per_aide)} to replace each (range ${money(ASSUMPTIONS.replacement_cost_low)}–${money(ASSUMPTIONS.replacement_cost_high)})`,
    explanation: 'Replacement cost is what the agency spends to get back to the same headcount. It is not lost revenue and is shown separately from revenue leaks.',
    inputs: { aide_turnover_12mo: n, replacement_cost: ASSUMPTIONS.replacement_cost_per_aide },
    provenance, grade: gradeFor(provenance),
    frequency_basis: { kind: 'records', sample_size: n, period_days: 365, description: `${n} departures over the last 12 months` },
    illustrative: false, missing_inputs: [],
  }
}

type DenialParts = { billed: number | null; rate: number; records: boolean; sample: number | null; provenance: Partial<Record<string, InputStatus>>; rateText: string; missing: string[] }
function denialParts(i: LeakInputs, s: InputStatuses): DenialParts {
  const billed = pos(i.billed_revenue_year) ? i.billed_revenue_year! : null
  const records = pos(i.claims_in_period) && i.denied_claims_in_period != null && i.denied_claims_in_period >= 0 && pos(i.period_days)
  const rate = records ? i.denied_claims_in_period! / i.claims_in_period! : i.evv_denial_rate
  const provenance: Partial<Record<string, InputStatus>> = { billed_revenue_year: billed == null ? 'assumed' : statusOf('billed_revenue_year', s, billed) }
  if (records) { provenance.denied_claims_in_period = statusOf('denied_claims_in_period', s, i.denied_claims_in_period); provenance.claims_in_period = statusOf('claims_in_period', s, i.claims_in_period) }
  else provenance.evv_denial_rate = statusOf('evv_denial_rate', s, i.evv_denial_rate)
  const missing = [...(billed == null ? ['billed_revenue_year'] : []), ...(records ? [] : ['denied_claims_in_period', 'claims_in_period', 'period_days'])]
  const rateText = records ? `${i.denied_claims_in_period} of ${i.claims_in_period} claims denied in ${i.period_days} days (${pct(rate)})` : `${pct(rate)} denied (owner-reported rate)`
  return { billed, rate, records, sample: records ? i.claims_in_period! : null, provenance, rateText, missing }
}

/**
 * Revenue lost to EVV/authorization denials that are never recovered. The base is the billed revenue supplied as an
 * input; it is never derived from the referral inputs, so this leak and the referral leak cannot share a dollar.
 * Only the unrecovered share is loss; the recoverable share goes to evvDenialDelayedLeak.
 */
export function evvDenialLeak(i: LeakInputs, t: TraceFacts, s: InputStatuses = {}): Leak {
  const d = denialParts(i, s)
  const denied = (d.billed ?? 0) * d.rate
  const base = denied * ASSUMPTIONS.unrecovered_share
  const { low, high } = widen(denied * ASSUMPTIONS.unrecovered_share_low, denied * ASSUMPTIONS.unrecovered_share_high, !d.records)
  const corroboration = t.visit_denied || t.exception_uncorrected ? ' The traced visit was denied or left uncorrected, which corroborates the pattern but does not change the frequency.' : ''
  return {
    key: 'evv_denials', label: 'Denied claims never recovered', door: 'operations', category: 'observed_lost_revenue',
    dollars_per_year: base, low, base, high,
    assumptions: {
      low: `${pct(ASSUMPTIONS.unrecovered_share_low)} of denied dollars never recovered${d.records ? '' : ', widened ÷' + ASSUMPTIONS.illustrative_widening}`,
      base: `${pct(ASSUMPTIONS.unrecovered_share)} of denied dollars never recovered; the rest is delayed payment, not loss`,
      high: `${pct(ASSUMPTIONS.unrecovered_share_high)} of denied dollars never recovered${d.records ? '' : ', widened ×' + ASSUMPTIONS.illustrative_widening}`,
    },
    formula: d.billed == null
      ? 'Billed revenue per year was not supplied, so this leak is not sized. It is never derived from the referral inputs.'
      : `${money(d.billed)} billed/yr (input) × ${d.rateText} × ${pct(ASSUMPTIONS.unrecovered_share)} never recovered. Non-overlap: billed revenue excludes referrals never won (referral leak) and unfilled hours (open-shift leak); the recoverable ${pct(1 - ASSUMPTIONS.unrecovered_share)} is counted once, as delayed payment.`,
    explanation: `A denied claim is late money until the correction window closes; after that it is lost. We size the loss on the agency's own billed revenue, not on an estimate built from referrals.${corroboration}`,
    inputs: { billed_revenue_year: d.billed, denial_rate: round(d.rate), unrecovered_share: ASSUMPTIONS.unrecovered_share, traced_visit_denied: t.visit_denied == null ? null : String(t.visit_denied) },
    provenance: d.provenance, grade: gradeFor(d.provenance),
    frequency_basis: d.records ? { kind: 'records', sample_size: d.sample!, period_days: i.period_days!, description: `n = ${d.sample} claims over ${i.period_days} days` } : { kind: 'illustrative', description: ILLUSTRATIVE_NOTE },
    illustrative: !d.records, missing_inputs: d.missing,
  }
}

/** The recoverable share of denied claims: late, not lost. Never counted as permanent loss. */
export function evvDenialDelayedLeak(i: LeakInputs, s: InputStatuses = {}): Leak {
  const d = denialParts(i, s)
  const denied = (d.billed ?? 0) * d.rate
  const base = denied * (1 - ASSUMPTIONS.unrecovered_share)
  const { low, high } = widen(denied * (1 - ASSUMPTIONS.unrecovered_share_high), denied * (1 - ASSUMPTIONS.unrecovered_share_low), !d.records)
  return {
    key: 'evv_denials_delayed', label: 'Denied claims recovered late', door: 'operations', category: 'delayed_payment',
    dollars_per_year: base, low, base, high,
    assumptions: {
      low: `${pct(1 - ASSUMPTIONS.unrecovered_share_high)} of denied dollars recovered after rework${d.records ? '' : ', widened ÷' + ASSUMPTIONS.illustrative_widening}`,
      base: `${pct(1 - ASSUMPTIONS.unrecovered_share)} of denied dollars recovered after rework`,
      high: `${pct(1 - ASSUMPTIONS.unrecovered_share_low)} of denied dollars recovered after rework${d.records ? '' : ', widened ×' + ASSUMPTIONS.illustrative_widening}`,
    },
    formula: d.billed == null
      ? 'Billed revenue per year was not supplied, so the delayed amount is not sized.'
      : `${money(d.billed)} billed/yr (input) × ${d.rateText} × ${pct(1 - ASSUMPTIONS.unrecovered_share)} recovered late. This is cash-flow delay, never counted as loss; the other ${pct(ASSUMPTIONS.unrecovered_share)} is the observed-loss leak.`,
    explanation: 'Denied claims that get corrected and rebilled still arrive, weeks late. They tie up cash and office time but are not lost, so they are shown as delayed payment.',
    inputs: { billed_revenue_year: d.billed, denial_rate: round(d.rate), recovered_share: 1 - ASSUMPTIONS.unrecovered_share },
    provenance: d.provenance, grade: gradeFor(d.provenance),
    frequency_basis: d.records ? { kind: 'records', sample_size: d.sample!, period_days: i.period_days!, description: `n = ${d.sample} claims over ${i.period_days} days` } : { kind: 'illustrative', description: ILLUSTRATIVE_NOTE },
    illustrative: !d.records, missing_inputs: d.missing,
  }
}

/** Office hours spent on manual chasing that a workflow would free. Capacity, never cash. */
export function staffCapacityLeak(i: LeakInputs, s: InputStatuses = {}): Leak {
  const hours = pos(i.admin_hours_week) ? i.admin_hours_week! : 0
  const rate = pos(i.admin_hourly_cost) ? i.admin_hourly_cost! : ASSUMPTIONS.default_admin_hourly_cost
  const value = hours * 52 * rate
  const provenance: Partial<Record<string, InputStatus>> = {
    admin_hours_week: statusOf('admin_hours_week', s, pos(i.admin_hours_week) ? i.admin_hours_week : null),
    admin_hourly_cost: pos(i.admin_hourly_cost) ? statusOf('admin_hourly_cost', s, i.admin_hourly_cost) : 'assumed',
  }
  return {
    key: 'staff_capacity', label: 'Office hours spent chasing by hand', door: 'operations', category: 'staff_capacity_released',
    dollars_per_year: value * ASSUMPTIONS.released_share, low: value * ASSUMPTIONS.released_share_low, base: value * ASSUMPTIONS.released_share, high: value * ASSUMPTIONS.released_share_high,
    assumptions: { low: `${pct(ASSUMPTIONS.released_share_low)} of the manual hours actually released`, base: `all reported manual hours released, valued at $${rate}/h loaded${pos(i.admin_hourly_cost) ? '' : ' (assumed)'}`, high: `${pct(ASSUMPTIONS.released_share_high)}: manual hours plus the interruptions around them` },
    formula: hours === 0 ? 'Weekly manual office hours were not supplied, so no capacity is sized.' : `${hours} h/wk × 52 × $${rate}/h loaded = value of hours released. Hours, not cash: nothing here is a saving unless an expenditure change is recorded.`,
    explanation: 'Calling aides one at a time, re-keying referrals and chasing EVV fixes are hours the office could spend elsewhere. We show the value of those hours; we do not call it savings unless payroll or a vendor bill actually changes.',
    inputs: { admin_hours_week: hours, admin_hourly_cost: rate },
    provenance, grade: gradeFor(provenance),
    frequency_basis: { kind: 'illustrative', description: 'owner-reported weekly hours; no time study' },
    illustrative: true, missing_inputs: hours === 0 ? ['admin_hours_week'] : [],
  }
}

/** Cash savings exist only when an expenditure change is recorded (a cancelled vendor, reduced overtime on a payroll report). */
export function cashSavingsLeak(i: LeakInputs, s: InputStatuses = {}): Leak | null {
  if (!pos(i.recorded_expenditure_change_year)) return null
  const v = i.recorded_expenditure_change_year!
  const provenance: Partial<Record<string, InputStatus>> = { recorded_expenditure_change_year: statusOf('recorded_expenditure_change_year', s, v) }
  return {
    key: 'cash_savings', label: 'Recorded expenditure change', door: 'operations', category: 'cash_savings',
    dollars_per_year: v, low: v, base: v, high: v,
    assumptions: { low: 'the recorded amount', base: 'the recorded amount', high: 'the recorded amount' },
    formula: `${money(v)}/yr expenditure change as recorded by the agency`,
    explanation: 'Only an expenditure change that is actually recorded counts as cash savings. Staff time is shown separately as capacity released.',
    inputs: { recorded_expenditure_change_year: v },
    provenance, grade: gradeFor(provenance),
    frequency_basis: { kind: 'records', sample_size: 1, period_days: 365, description: 'recorded expenditure change' },
    illustrative: false, missing_inputs: [],
  }
}

export function allLeaks(i: LeakInputs, t: TraceFacts, s: InputStatuses = {}): Leak[] {
  const out: Leak[] = [referralResponseLeak(i, t, s), openShiftLeak(i, s), turnoverLeak(i, s), evvDenialLeak(i, t, s), evvDenialDelayedLeak(i, s), staffCapacityLeak(i, s)]
  const cash = cashSavingsLeak(i, s)
  if (cash) out.push(cash)
  return out
}

/** The n biggest leaks by base, largest first. */
export function topLeaks(i: LeakInputs, t: TraceFacts, n = 3, s: InputStatuses = {}): Leak[] {
  return allLeaks(i, t, s).sort((a, b) => b.base - a.base).slice(0, n)
}

export function recommendedDoor(leaks: Leak[]): Door {
  return leaks[0]?.door ?? 'growth'
}

/** Totals per category. Categories are never summed into one number on the report. */
export function categoryTotals(leaks: Leak[]): Record<LeakCategory, number> {
  const out = Object.fromEntries(LEAK_CATEGORIES.map(c => [c, 0])) as Record<LeakCategory, number>
  for (const l of leaks) out[l.category] += Number(l.base ?? l.dollars_per_year) || 0
  return out
}

/** Inputs that carry revenue. No two observed-loss leaks may use the same one (tested). */
export const REVENUE_INPUTS: string[] = ['avg_monthly_referrals', 'referrals_in_period', 'avg_referral_value_year', 'billed_revenue_year', 'open_shift_hours_week', 'open_shifts_in_period']

export const DOOR_SCOPE: Record<Door, { title: string; scope: string[] }> = {
  growth: { title: 'Growth: win more referrals', scope: ['Referral inbox and phone line watched; reply inside the hour with capacity confirmed', 'Intake started the same day; follow-up to the referrer at 7 and 30 days', 'Private-pay inquiries called back before the next agency'] },
  staffing: { title: 'Staffing: hire and keep more aides', scope: ['Applicants screened by text and interview-booked in under 10 minutes', '30/60/90-day check-ins with a quit-risk flag', 'Credentials tracked, lapses flagged before they void a claim'] },
  operations: { title: 'Operations: keep every visit, and get paid for it', scope: ['Open shifts offered to qualified aides automatically; family confirmed', 'EVV exceptions caught and fixed inside the correction window', 'Authorization units watched so care never outruns the auth'] },
}

/** Numbers from a form or a stored jsonb. Required inputs default to 0; optional ones to null. The denial rate accepts a percent. */
export function parseInputs(raw: Record<string, unknown>): LeakInputs {
  const num = (k: string, d = 0) => { const v = Number(raw[k]); return Number.isFinite(v) && v >= 0 && raw[k] !== '' && raw[k] != null ? v : d }
  const opt = (k: string) => { const r = raw[k]; if (r == null || r === '') return null; const v = Number(r); return Number.isFinite(v) && v >= 0 ? v : null }
  const rate = num('evv_denial_rate')
  return {
    avg_monthly_referrals: num('avg_monthly_referrals'),
    avg_referral_value_year: num('avg_referral_value_year'),
    aide_turnover_12mo: num('aide_turnover_12mo'),
    open_shift_hours_week: num('open_shift_hours_week'),
    evv_denial_rate: rate > 1 ? Math.min(1, rate / 100) : rate,
    period_days: opt('period_days'),
    referrals_in_period: opt('referrals_in_period'),
    claims_in_period: opt('claims_in_period'),
    denied_claims_in_period: opt('denied_claims_in_period'),
    open_shifts_in_period: opt('open_shifts_in_period'),
    avg_shift_hours: opt('avg_shift_hours'),
    billed_revenue_year: opt('billed_revenue_year'),
    admin_hours_week: opt('admin_hours_week'),
    admin_hourly_cost: opt('admin_hourly_cost'),
    recorded_expenditure_change_year: opt('recorded_expenditure_change_year'),
  }
}

/** Per-input statuses from a form (`status_<key>`) or a stored map; unknown values are dropped. */
export function parseStatuses(raw: Record<string, unknown>): InputStatuses {
  const out: InputStatuses = {}
  for (const k of INPUT_KEYS) {
    const v = raw[`status_${k}`] ?? (raw.statuses as Record<string, unknown> | undefined)?.[k]
    if (typeof v === 'string' && (INPUT_STATUSES as string[]).includes(v)) out[k] = v as InputStatus
  }
  return out
}
