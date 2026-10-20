/**
 * Leak calculator. Pure functions, no I/O. Every number shown to a client comes
 * from one of these formulas, and the formula text is shown next to the dollars.
 *
 * Inputs (five, entered by staff during the assessment) plus what the two traces
 * revealed (referral response delay, whether the traced visit was denied).
 */
export type LeakInputs = {
  avg_monthly_referrals: number
  avg_referral_value_year: number
  aide_turnover_12mo: number
  open_shift_hours_week: number
  /** 0–1 */
  evv_denial_rate: number
}

export type TraceFacts = {
  /** hours from referral received to first response; null when the trace has no timestamps */
  referral_response_hours: number | null
  /** did the traced visit end denied? */
  visit_denied: boolean | null
  /** was an exception raised and not corrected inside the window? */
  exception_uncorrected: boolean | null
}

export type Leak = {
  key: 'referral_response' | 'open_shifts' | 'turnover' | 'evv_denials'
  label: string
  door: 'growth' | 'staffing' | 'operations'
  dollars_per_year: number
  formula: string
  inputs: Record<string, number | string>
}

/** Assumptions, shown on the report so the client can argue with them. */
export const ASSUMPTIONS = {
  /** referrals answered inside this many hours are treated as "on time" */
  on_time_hours: 1,
  /** share of referrals lost per hour of delay past on-time, capped below */
  lost_share_per_hour: 0.025,
  lost_share_cap: 0.5,
  /** fallback when the referral trace has no timestamps */
  default_response_hours: 8,
  /** share of open-shift hours that never get filled */
  unfilled_share: 0.3,
  /** billed rate per hour of care (Ohio PASSPORT personal care, rounded) */
  billed_rate_per_hour: 26,
  /** margin share on a billed hour after aide pay and payroll costs */
  margin_share: 0.35,
  /** fully loaded cost to replace one aide: recruiting, onboarding, training, lost hours */
  replacement_cost_per_aide: 2500,
  /** win rate on referrals × average client tenure in years (0.5 × 2) */
  book_multiplier: 1,
  /** share of denied claims that is never recovered */
  unrecovered_share: 0.5,
}

export const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
const round = (n: number) => Math.round(n * 100) / 100

/** Lost referral revenue from slow response. Delay comes from the referral trace. */
export function referralResponseLeak(i: LeakInputs, t: TraceFacts): Leak {
  const hours = t.referral_response_hours ?? ASSUMPTIONS.default_response_hours
  const lostShare = Math.min(ASSUMPTIONS.lost_share_cap, Math.max(0, hours - ASSUMPTIONS.on_time_hours) * ASSUMPTIONS.lost_share_per_hour)
  const dollars = i.avg_monthly_referrals * 12 * i.avg_referral_value_year * lostShare
  return {
    key: 'referral_response', label: 'Referrals lost to slow response', door: 'growth', dollars_per_year: dollars,
    formula: `${i.avg_monthly_referrals} referrals/mo × 12 × ${money(i.avg_referral_value_year)}/yr × ${Math.round(lostShare * 100)}% lost (${round(hours)} h response; ${ASSUMPTIONS.lost_share_per_hour * 100}%/h past ${ASSUMPTIONS.on_time_hours} h, cap ${ASSUMPTIONS.lost_share_cap * 100}%)`,
    inputs: { avg_monthly_referrals: i.avg_monthly_referrals, avg_referral_value_year: i.avg_referral_value_year, response_hours: round(hours), lost_share: round(lostShare), source: t.referral_response_hours == null ? 'assumed' : 'trace' },
  }
}

/** Margin lost on open-shift hours that never get filled. */
export function openShiftLeak(i: LeakInputs): Leak {
  const dollars = i.open_shift_hours_week * 52 * ASSUMPTIONS.unfilled_share * ASSUMPTIONS.billed_rate_per_hour * ASSUMPTIONS.margin_share
  return {
    key: 'open_shifts', label: 'Open shifts never filled', door: 'operations', dollars_per_year: dollars,
    formula: `${i.open_shift_hours_week} open h/wk × 52 × ${ASSUMPTIONS.unfilled_share * 100}% unfilled × $${ASSUMPTIONS.billed_rate_per_hour}/h × ${ASSUMPTIONS.margin_share * 100}% margin`,
    inputs: { open_shift_hours_week: i.open_shift_hours_week, unfilled_share: ASSUMPTIONS.unfilled_share, billed_rate: ASSUMPTIONS.billed_rate_per_hour, margin_share: ASSUMPTIONS.margin_share },
  }
}

/** Replacement cost of aides who left in the last 12 months. */
export function turnoverLeak(i: LeakInputs): Leak {
  const dollars = i.aide_turnover_12mo * ASSUMPTIONS.replacement_cost_per_aide
  return {
    key: 'turnover', label: 'Aide turnover', door: 'staffing', dollars_per_year: dollars,
    formula: `${i.aide_turnover_12mo} aides left × ${money(ASSUMPTIONS.replacement_cost_per_aide)} to replace each`,
    inputs: { aide_turnover_12mo: i.aide_turnover_12mo, replacement_cost: ASSUMPTIONS.replacement_cost_per_aide },
  }
}

/**
 * Revenue lost to EVV/authorization denials that are never recovered.
 * Annual billed is estimated from the referral inputs: referrals/mo × 12 × value/yr
 * × book multiplier (≈50% win rate × ≈2-year tenure = 1).
 */
export function evvDenialLeak(i: LeakInputs, t: TraceFacts): Leak {
  const annualBilled = i.avg_monthly_referrals * 12 * i.avg_referral_value_year * ASSUMPTIONS.book_multiplier
  const unrecovered = t.visit_denied || t.exception_uncorrected ? Math.min(1, ASSUMPTIONS.unrecovered_share + 0.25) : ASSUMPTIONS.unrecovered_share
  const dollars = annualBilled * i.evv_denial_rate * unrecovered
  return {
    key: 'evv_denials', label: 'EVV and authorization denials', door: 'operations', dollars_per_year: dollars,
    formula: `${money(annualBilled)} billed/yr (est.) × ${round(i.evv_denial_rate * 100)}% denied × ${Math.round(unrecovered * 100)}% never recovered${t.visit_denied || t.exception_uncorrected ? ' (traced visit was denied/uncorrected)' : ''}`,
    inputs: { annual_billed_estimate: Math.round(annualBilled), evv_denial_rate: i.evv_denial_rate, unrecovered_share: unrecovered },
  }
}

export function allLeaks(i: LeakInputs, t: TraceFacts): Leak[] {
  return [referralResponseLeak(i, t), openShiftLeak(i), turnoverLeak(i), evvDenialLeak(i, t)]
}

/** The three biggest leaks, largest first. */
export function topLeaks(i: LeakInputs, t: TraceFacts, n = 3): Leak[] {
  return allLeaks(i, t).sort((a, b) => b.dollars_per_year - a.dollars_per_year).slice(0, n)
}

export function recommendedDoor(leaks: Leak[]): Leak['door'] {
  return leaks[0]?.door ?? 'growth'
}

export const DOOR_SCOPE: Record<Leak['door'], { title: string; scope: string[] }> = {
  growth: { title: 'Growth: win more referrals', scope: ['Referral inbox and phone line watched; reply inside the hour with capacity confirmed', 'Intake started the same day; follow-up to the referrer at 7 and 30 days', 'Private-pay inquiries called back before the next agency'] },
  staffing: { title: 'Staffing: hire and keep more aides', scope: ['Applicants screened by text and interview-booked in under 10 minutes', '30/60/90-day check-ins with a quit-risk flag', 'Credentials tracked, lapses flagged before they void a claim'] },
  operations: { title: 'Operations: keep every visit, and get paid for it', scope: ['Open shifts offered to qualified aides automatically; family confirmed', 'EVV exceptions caught and fixed inside the correction window', 'Authorization units watched so care never outruns the auth'] },
}

export function parseInputs(raw: Record<string, unknown>): LeakInputs {
  const num = (k: string, d = 0) => { const v = Number(raw[k]); return Number.isFinite(v) && v >= 0 ? v : d }
  const rate = num('evv_denial_rate')
  return {
    avg_monthly_referrals: num('avg_monthly_referrals'),
    avg_referral_value_year: num('avg_referral_value_year'),
    aide_turnover_12mo: num('aide_turnover_12mo'),
    open_shift_hours_week: num('open_shift_hours_week'),
    evv_denial_rate: rate > 1 ? Math.min(1, rate / 100) : rate,
  }
}
