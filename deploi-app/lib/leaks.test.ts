import { describe, it, expect } from 'vitest'
import {
  referralResponseLeak, openShiftLeak, turnoverLeak, evvDenialLeak, evvDenialDelayedLeak, staffCapacityLeak, cashSavingsLeak,
  allLeaks, topLeaks, recommendedDoor, parseInputs, parseStatuses, categoryTotals, gradeFor, ASSUMPTIONS, REVENUE_INPUTS, LEAK_CATEGORIES,
  type LeakInputs, type Leak,
} from './leaks'

/** Owner-reported averages only: no broader records. */
const I: LeakInputs = {
  avg_monthly_referrals: 10, avg_referral_value_year: 20000, aide_turnover_12mo: 6, open_shift_hours_week: 20, evv_denial_rate: 0.05,
  period_days: null, referrals_in_period: null, claims_in_period: null, denied_claims_in_period: null, open_shifts_in_period: null, avg_shift_hours: null,
  billed_revenue_year: 1000000, admin_hours_week: 10, admin_hourly_cost: null, recorded_expenditure_change_year: null,
}
/** The same agency with 90 days of records. */
const R: LeakInputs = { ...I, period_days: 90, referrals_in_period: 30, claims_in_period: 600, denied_claims_in_period: 30, open_shifts_in_period: 60, avg_shift_hours: 4, admin_hourly_cost: 30 }
const T = { referral_response_hours: 5, visit_denied: false, exception_uncorrected: false }

describe('leak formulas', () => {
  it('referral response: 10×12×20000 × 10% (5h → 4h past on-time × 2.5%), a potential opportunity, not a loss', () => {
    const l = referralResponseLeak(I, T)
    expect(l.category).toBe('potential_revenue_opportunity')
    expect(l.base).toBeCloseTo(10 * 12 * 20000 * 0.1, 2)
    expect(l.dollars_per_year).toBe(l.base)
    expect(l.formula).toContain('10% lost')
    expect(l.inputs.source).toBe('trace')
    expect(l.low).toBeLessThan(l.base)
    expect(l.high).toBeGreaterThan(l.base)
  })
  it('referral response caps at 50% and falls back to 8 h without a trace (assumed → grade C)', () => {
    expect(referralResponseLeak(I, { ...T, referral_response_hours: 100 }).base).toBeCloseTo(2400000 * 0.5, 2)
    const l = referralResponseLeak(I, { ...T, referral_response_hours: null })
    expect(l.inputs.response_hours).toBe(ASSUMPTIONS.default_response_hours)
    expect(l.provenance.referral_response_hours).toBe('assumed')
    expect(l.grade).toBe('C')
    expect(referralResponseLeak(I, { ...T, referral_response_hours: 0.5 }).base).toBe(0)
  })
  it('open shifts: 20×52×0.3×26×0.35, observed loss on margin', () => {
    const l = openShiftLeak(I)
    expect(l.category).toBe('observed_lost_revenue')
    expect(l.base).toBeCloseTo(20 * 52 * 0.3 * 26 * 0.35, 2)
  })
  it('turnover: 6 × 2500 base, 1500 low, 4000 high, as a replacement-cost estimate', () => {
    const l = turnoverLeak(I)
    expect(l.category).toBe('estimated_turnover_replacement_cost')
    expect([l.low, l.base, l.high]).toEqual([9000, 15000, 24000])
    expect(l.illustrative).toBe(false)
  })
  it('denials: base is billed revenue from the input, never the referral book; only the unrecovered half is loss, the rest is delayed payment', () => {
    const loss = evvDenialLeak(I, T)
    const late = evvDenialDelayedLeak(I)
    expect(loss.category).toBe('observed_lost_revenue')
    expect(late.category).toBe('delayed_payment')
    expect(loss.base).toBeCloseTo(1000000 * 0.05 * 0.5, 2)
    expect(late.base).toBeCloseTo(1000000 * 0.05 * 0.5, 2)
    expect(loss.base + late.base).toBeCloseTo(1000000 * 0.05, 2)
    expect(loss.inputs.billed_revenue_year).toBe(1000000)
    expect(loss.formula).toContain('Non-overlap')
    // the traced denial corroborates; it does not change the number
    expect(evvDenialLeak(I, { ...T, visit_denied: true }).base).toBeCloseTo(loss.base, 2)
    expect(evvDenialLeak(I, { ...T, visit_denied: true }).explanation).toContain('corroborates')
  })
  it('denials without a billed-revenue input are not sized and say so', () => {
    const l = evvDenialLeak({ ...I, billed_revenue_year: null }, T)
    expect(l.base).toBe(0)
    expect(l.missing_inputs).toContain('billed_revenue_year')
    expect(l.formula).toContain('never derived from the referral inputs')
  })
  it('staff time is capacity released, never cash; cash savings only with a recorded expenditure change', () => {
    const cap = staffCapacityLeak(I)
    expect(cap.category).toBe('staff_capacity_released')
    expect(cap.base).toBeCloseTo(10 * 52 * ASSUMPTIONS.default_admin_hourly_cost, 2)
    expect(cap.provenance.admin_hourly_cost).toBe('assumed')
    expect(cashSavingsLeak(I)).toBeNull()
    expect(allLeaks(I, T).some(l => l.category === 'cash_savings')).toBe(false)
    const cash = cashSavingsLeak({ ...I, recorded_expenditure_change_year: 4800 })!
    expect(cash.category).toBe('cash_savings')
    expect([cash.low, cash.base, cash.high]).toEqual([4800, 4800, 4800])
  })
})

describe('frequency basis and evidence grade', () => {
  it('without broader records a leak is illustrative with widened bounds; with records it is measured', () => {
    const ill = referralResponseLeak(I, T)
    expect(ill.illustrative).toBe(true)
    expect(ill.frequency_basis.kind).toBe('illustrative')
    expect(ill.frequency_basis.description).toContain('single traced event')
    expect(ill.missing_inputs).toEqual(['referrals_in_period', 'period_days'])
    const rec = referralResponseLeak(R, T)
    expect(rec.illustrative).toBe(false)
    expect(rec.frequency_basis).toMatchObject({ kind: 'records', sample_size: 30, period_days: 90 })
    // 30 referrals / 90 days → 121.67/yr vs 120/yr owner-reported; same lost share
    expect(rec.base).toBeCloseTo((30 * 365 / 90) * 20000 * 0.1, 2)
    // illustrative bounds are wider relative to base than the record-based ones
    expect(ill.high / ill.base).toBeGreaterThan(rec.high / rec.base)
    expect(ill.low / ill.base).toBeLessThan(rec.low / rec.base)
  })
  it('denial rate from records: 30 of 600 claims = 5%, sample n = 600', () => {
    const l = evvDenialLeak(R, T)
    expect(l.illustrative).toBe(false)
    expect(l.frequency_basis).toMatchObject({ kind: 'records', sample_size: 600 })
    expect(l.inputs.denial_rate).toBe(0.05)
    expect(l.provenance.claims_in_period).toBe('measured')
  })
  it('grade: A when every input is measured, B with an owner-reported one, C with any assumption', () => {
    expect(gradeFor({ a: 'measured', b: 'measured' })).toBe('A')
    expect(gradeFor({ a: 'measured', b: 'owner_reported' })).toBe('B')
    expect(gradeFor({ a: 'measured', b: 'assumed' })).toBe('C')
    expect(gradeFor({})).toBe('C')
    // denial leak from records with the billed revenue measured → A; owner-reported billed revenue → B
    expect(evvDenialLeak(R, T, { billed_revenue_year: 'measured' }).grade).toBe('A')
    expect(evvDenialLeak(R, T).grade).toBe('B')
    // an owner-reported average with a measured trace → B; an assumed shift length drags open shifts to C
    expect(referralResponseLeak(I, T).grade).toBe('B')
    expect(openShiftLeak({ ...R, avg_shift_hours: null }).grade).toBe('C')
    expect(openShiftLeak(R).grade).toBe('C') // avg_shift_hours defaults to assumed status
    expect(openShiftLeak(R, { avg_shift_hours: 'measured' }).grade).toBe('A')
    // statuses override the defaults
    expect(turnoverLeak(I, { aide_turnover_12mo: 'measured' }).grade).toBe('A')
    expect(turnoverLeak(I, { aide_turnover_12mo: 'assumed' }).grade).toBe('C')
  })
})

describe('no double counting', () => {
  const check = (leaks: Leak[]) => {
    const totals = categoryTotals(leaks)
    const sumCategories = LEAK_CATEGORIES.reduce((s, c) => s + totals[c], 0)
    const sumBases = leaks.reduce((s, l) => s + l.base, 0)
    expect(sumCategories).toBeCloseTo(sumBases, 6)
    const seen = new Map<string, string>()
    for (const l of leaks.filter(x => x.category === 'observed_lost_revenue')) {
      for (const k of Object.keys(l.provenance)) {
        if (!REVENUE_INPUTS.includes(k)) continue
        expect(seen.has(k), `${k} used by ${seen.get(k)} and ${l.key}`).toBe(false)
        seen.set(k, l.key)
      }
    }
  }
  it('sum of category totals equals the sum of leak bases and no revenue input appears in two observed-loss leaks', () => {
    check(allLeaks(I, T))
    check(allLeaks(R, T))
    check(allLeaks({ ...R, recorded_expenditure_change_year: 1200 }, T))
    check(topLeaks(R, T))
  })
  it('the referral leak and the denial leak share no input at all', () => {
    const ref = referralResponseLeak(R, T)
    const den = evvDenialLeak(R, T)
    const overlap = Object.keys(ref.provenance).filter(k => k in den.provenance)
    expect(overlap).toEqual([])
  })
})

describe('ranking and parsing', () => {
  it('topLeaks returns the three largest by base, sorted, and the door follows the biggest', () => {
    const top = topLeaks(I, T)
    expect(top.length).toBe(3)
    expect(top[0].key).toBe('referral_response')
    expect(top[0].base).toBeGreaterThanOrEqual(top[1].base)
    expect(top[1].base).toBeGreaterThanOrEqual(top[2].base)
    expect(recommendedDoor(top)).toBe('growth')
    expect(recommendedDoor(topLeaks({ ...I, avg_monthly_referrals: 0, billed_revenue_year: null, admin_hours_week: null, aide_turnover_12mo: 30 }, T))).toBe('staffing')
  })
  it('parseInputs coerces strings, rejects negatives, accepts a percent for the denial rate and leaves optional inputs null', () => {
    const p = parseInputs({ avg_monthly_referrals: '7', avg_referral_value_year: -5, aide_turnover_12mo: 'x', open_shift_hours_week: '12.5', evv_denial_rate: '6', period_days: '90', billed_revenue_year: '' })
    expect(p).toMatchObject({ avg_monthly_referrals: 7, avg_referral_value_year: 0, aide_turnover_12mo: 0, open_shift_hours_week: 12.5, evv_denial_rate: 0.06, period_days: 90, billed_revenue_year: null, referrals_in_period: null })
    expect(parseInputs({ evv_denial_rate: '0.08' }).evv_denial_rate).toBe(0.08)
  })
  it('parseStatuses reads status_<key> fields and drops unknown values', () => {
    expect(parseStatuses({ status_avg_monthly_referrals: 'measured', status_billed_revenue_year: 'bogus', status_period_days: 'assumed' })).toEqual({ avg_monthly_referrals: 'measured', period_days: 'assumed' })
    expect(parseStatuses({ statuses: { aide_turnover_12mo: 'owner_reported' } })).toEqual({ aide_turnover_12mo: 'owner_reported' })
  })
})
