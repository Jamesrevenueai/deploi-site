import { describe, it, expect } from 'vitest'
import { pickRuleSet, windowCloses, daysLeft, windowTone, windowLabel, ruleSourceLabel, DEADLINE_NOT_CONFIGURED, type RuleSet } from './window'

const rule = (o: Partial<RuleSet>): RuleSet => ({
  id: o.id ?? 'r', agency_id: null, program: null, payer: null, jurisdiction: 'OH', effective_from: null, effective_to: null, correction_window_days: 60,
  unit_minutes: 15, unit_rounding: 'nearest', duration_tolerance_min: 15, source_name: 'Working assumption, confirm with ODM', source_url: null, source_version: null, verified: false, notes: null, ...o,
})
const q = (o: Partial<Parameters<typeof pickRuleSet>[1]> = {}) => ({ agencyId: 'A', state: 'OH', program: 'PASSPORT', payer: null, date: new Date('2026-10-01T12:00:00Z'), ...o })

describe('rule-set resolution', () => {
  it('returns null when nothing matches: unknown state, other program, other agency, outside the effective dates', () => {
    const rules = [rule({ id: 'passport', program: 'PASSPORT', agency_id: 'A', effective_from: '2026-01-01' })]
    expect(pickRuleSet(rules, q({ state: 'IN' }))).toBeNull()
    expect(pickRuleSet(rules, q({ program: 'OHCW' }))).toBeNull()
    expect(pickRuleSet(rules, q({ program: null }))).toBeNull()
    expect(pickRuleSet(rules, q({ agencyId: 'B' }))).toBeNull()
    expect(pickRuleSet(rules, q({ date: new Date('2025-12-31T00:00:00Z') }))).toBeNull()
    expect(pickRuleSet([], q())).toBeNull()
    expect(pickRuleSet(rules, q())?.id).toBe('passport')
  })
  it('prefers the most specific match', () => {
    const rules = [rule({ id: 'global' }), rule({ id: 'prog', program: 'passport' }), rule({ id: 'agency', agency_id: 'A' }), rule({ id: 'agency-prog', agency_id: 'A', program: 'PASSPORT' })]
    expect(pickRuleSet(rules, q())?.id).toBe('agency-prog')
    expect(pickRuleSet(rules, q({ program: 'OHCW' }))?.id).toBe('agency')
    expect(pickRuleSet(rules, q({ agencyId: 'B' }))?.id).toBe('prog')
    expect(pickRuleSet(rules, q({ agencyId: 'B', program: 'DODD' }))?.id).toBe('global')
  })
  it('never fabricates a deadline: no rule or a rule without a window gives null, and the label says so', () => {
    const visit = new Date('2026-10-01T12:00:00Z')
    expect(windowCloses(visit, null)).toBeNull()
    expect(windowCloses(visit, rule({ correction_window_days: null }))).toBeNull()
    expect(windowCloses(visit, rule({ correction_window_days: 60 }))?.toISOString()).toBe('2026-11-30T12:00:00.000Z')
    expect(windowLabel(null)).toBe(DEADLINE_NOT_CONFIGURED)
    expect(windowTone(null)).toBe('muted')
    expect(ruleSourceLabel(null)).toBe(DEADLINE_NOT_CONFIGURED)
    expect(ruleSourceLabel(rule({ source_version: '2026-10' }))).toBe('Working assumption, confirm with ODM · v2026-10 · unverified')
  })
  it('computes days left and tones', () => {
    const closes = windowCloses(new Date('2026-10-01T12:00:00Z'), rule({}))!
    expect(daysLeft(closes, new Date('2026-11-25T12:00:00Z'))).toBe(5)
    expect(windowTone(7)).toBe('danger'); expect(windowTone(0)).toBe('danger'); expect(windowTone(-3)).toBe('danger')
    expect(windowTone(8)).toBe('warn'); expect(windowTone(21)).toBe('warn'); expect(windowTone(22)).toBe('none')
    expect(windowLabel(3)).toBe('3d left'); expect(windowLabel(0)).toBe('closes today'); expect(windowLabel(-2)).toBe('closed 2d ago')
  })
})
