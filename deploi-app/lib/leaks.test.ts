import { describe, it, expect } from 'vitest'
import { referralResponseLeak, openShiftLeak, turnoverLeak, evvDenialLeak, topLeaks, recommendedDoor, parseInputs, ASSUMPTIONS, type LeakInputs } from './leaks'

const I: LeakInputs = { avg_monthly_referrals: 10, avg_referral_value_year: 20000, aide_turnover_12mo: 6, open_shift_hours_week: 20, evv_denial_rate: 0.05 }
const T = { referral_response_hours: 5, visit_denied: false, exception_uncorrected: false }

describe('leak formulas', () => {
  it('referral response: 10×12×20000 × 10% (5h → 4h past on-time × 2.5%)', () => {
    const l = referralResponseLeak(I, T)
    expect(l.dollars_per_year).toBeCloseTo(10 * 12 * 20000 * 0.1, 2)
    expect(l.formula).toContain('10% lost')
    expect(l.inputs.source).toBe('trace')
  })
  it('referral response caps at 50% and falls back to 8 h without a trace', () => {
    expect(referralResponseLeak(I, { ...T, referral_response_hours: 100 }).dollars_per_year).toBeCloseTo(2400000 * 0.5, 2)
    const l = referralResponseLeak(I, { ...T, referral_response_hours: null })
    expect(l.inputs.response_hours).toBe(ASSUMPTIONS.default_response_hours)
    expect(l.inputs.source).toBe('assumed')
    expect(referralResponseLeak(I, { ...T, referral_response_hours: 0.5 }).dollars_per_year).toBe(0)
  })
  it('open shifts: 20×52×0.3×26×0.35', () => {
    expect(openShiftLeak(I).dollars_per_year).toBeCloseTo(20 * 52 * 0.3 * 26 * 0.35, 2)
  })
  it('turnover: 6 × 2500', () => {
    expect(turnoverLeak(I).dollars_per_year).toBe(15000)
  })
  it('evv denials: 2.4M × 5% × 50%, rises to 75% when the traced visit was denied', () => {
    expect(evvDenialLeak(I, T).dollars_per_year).toBeCloseTo(2400000 * 0.05 * 0.5, 2)
    expect(evvDenialLeak(I, { ...T, visit_denied: true }).dollars_per_year).toBeCloseTo(2400000 * 0.05 * 0.75, 2)
  })
  it('topLeaks returns the three largest, sorted, and the door follows the biggest', () => {
    const top = topLeaks(I, T)
    expect(top.map(l => l.key)).toEqual(['referral_response', 'evv_denials', 'turnover'])
    expect(top[0].dollars_per_year).toBeGreaterThanOrEqual(top[1].dollars_per_year)
    expect(recommendedDoor(top)).toBe('growth')
    expect(recommendedDoor(topLeaks({ ...I, avg_monthly_referrals: 0, aide_turnover_12mo: 30 }, T))).toBe('staffing')
  })
  it('parseInputs coerces strings, rejects negatives and accepts a percent for the denial rate', () => {
    const p = parseInputs({ avg_monthly_referrals: '7', avg_referral_value_year: -5, aide_turnover_12mo: 'x', open_shift_hours_week: '12.5', evv_denial_rate: '6' })
    expect(p).toEqual({ avg_monthly_referrals: 7, avg_referral_value_year: 0, aide_turnover_12mo: 0, open_shift_hours_week: 12.5, evv_denial_rate: 0.06 })
    expect(parseInputs({ evv_denial_rate: '0.08' }).evv_denial_rate).toBe(0.08)
  })
})
