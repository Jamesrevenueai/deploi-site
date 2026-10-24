import './env'
import { describe, it, expect } from 'vitest'
import {
  CONTRIBUTION_LABEL, DEFAULT_RATES, isCollected, isProjected, isMock, collectedCents, projectedCents, mockCents, hoursByKind, laborCents,
  implementationContribution, monthlyContribution, reviewTimePerCase, supportTimePerAgency, costPerCompletedWorkflow, agencyRollup, websiteContribution, dollars,
  type RevenueEntry, type LaborEntry, type CostEntry, type Rates,
} from '../../lib/economics/calc'

const A = 'agency-a'
const E = 'eng-1'
const rates: Rates = { ...DEFAULT_RATES, build_labor: 10000, review_labor: 8000, support_labor: 6000, troubleshooting_labor: 12000 }
const rev: RevenueEntry[] = [
  { agency_id: A, ref_type: 'engagement', ref_id: E, kind: 'setup_fee', amount_cents: 300000, status: 'collected', is_mock: false, collected_on: '2026-10-02' },
  { agency_id: A, ref_type: 'engagement', ref_id: E, kind: 'setup_fee', amount_cents: 100000, status: 'invoiced', is_mock: false, collected_on: null },
  { agency_id: A, ref_type: 'engagement', ref_id: E, kind: 'monthly_fee', amount_cents: 75000, status: 'collected', is_mock: false, collected_on: '2026-10-05' },
  { agency_id: A, ref_type: 'engagement', ref_id: E, kind: 'monthly_fee', amount_cents: 75000, status: 'projected', is_mock: false, collected_on: null },
  { agency_id: A, ref_type: 'agency', ref_id: null, kind: 'other', amount_cents: 99900, status: 'mock', is_mock: true, collected_on: '2026-10-06' },
  { agency_id: A, ref_type: 'agency', ref_id: null, kind: 'other', amount_cents: 55500, status: 'collected', is_mock: true, collected_on: '2026-10-06' }, // flagged mock but status collected
  { agency_id: 'other', ref_type: 'agency', ref_id: null, kind: 'monthly_fee', amount_cents: 1, status: 'collected', is_mock: false, collected_on: '2026-10-01' },
]
const labor: LaborEntry[] = [
  { agency_id: A, ref_type: 'engagement', ref_id: E, kind: 'build', hours: 12.5, logged_on: '2026-09-20' },
  { agency_id: A, ref_type: 'agency', ref_id: null, kind: 'review', hours: 3, logged_on: '2026-10-03' },
  { agency_id: A, ref_type: 'agency', ref_id: null, kind: 'support', hours: 1.5, logged_on: '2026-10-04' },
  { agency_id: A, ref_type: 'agency', ref_id: null, kind: 'troubleshooting', hours: 0.5, logged_on: '2026-10-04' },
  { agency_id: A, ref_type: 'agency', ref_id: null, kind: 'review', hours: 2, logged_on: '2026-09-28' }, // previous month
  { agency_id: null, ref_type: 'general', ref_id: null, kind: 'support', hours: 4, logged_on: '2026-10-04' },
]
const costs: CostEntry[] = [
  { agency_id: A, ref_type: 'engagement', ref_id: E, kind: 'third_party', amount_cents: 4000, incurred_on: '2026-09-21' },
  { agency_id: A, ref_type: 'agency', ref_id: null, kind: 'hosting', amount_cents: 2500, incurred_on: '2026-10-02' },
  { agency_id: A, ref_type: 'agency', ref_id: null, kind: 'model_usage', amount_cents: 1800, incurred_on: '2026-10-02' },
  { agency_id: A, ref_type: 'agency', ref_id: null, kind: 'credit', amount_cents: -500, incurred_on: '2026-10-03' },
]

describe('economics calc', () => {
  it('mock revenue is never collected or projected, whatever its status says', () => {
    expect(isMock(rev[4])).toBe(true)
    expect(isMock(rev[5])).toBe(true)
    expect(isCollected(rev[5])).toBe(false)
    expect(isProjected(rev[4])).toBe(false)
    expect(collectedCents(rev.filter(r => r.agency_id === A))).toBe(375000)
    expect(projectedCents(rev.filter(r => r.agency_id === A))).toBe(175000)
    expect(mockCents(rev)).toBe(99900 + 55500)
  })

  it('labor hours and value by kind', () => {
    const h = hoursByKind(labor)
    expect(h).toEqual({ assessment: 0, build: 12.5, review: 5, support: 5.5, troubleshooting: 0.5 })
    expect(laborCents(labor, rates, ['build'])).toBe(125000)
    expect(laborCents(labor, rates)).toBe(125000 + 5 * 8000 + 5.5 * 6000 + 0.5 * 12000)
  })

  it('implementation contribution = collected setup fee − build labor × rate − implementation costs', () => {
    const c = implementationContribution(E, rev, labor, costs, rates)
    expect(c.collectedSetupCents).toBe(300000)
    expect(c.projectedSetupCents).toBe(100000)
    expect(c.buildHours).toBe(12.5)
    expect(c.buildLaborCents).toBe(125000)
    expect(c.implementationCostCents).toBe(4000)
    expect(c.contributionCents).toBe(300000 - 125000 - 4000)
    expect(c.label).toBe(CONTRIBUTION_LABEL)
  })

  it('monthly contribution counts only that month, ops labor and run costs', () => {
    const m = monthlyContribution(A, '2026-10', rev, labor, costs, rates)
    expect(m.collectedMonthlyCents).toBe(75000)
    expect(m.projectedMonthlyCents).toBe(75000)
    expect(m.opsLaborCents).toBe(3 * 8000 + 1.5 * 6000 + 0.5 * 12000)
    expect(m.runCostCents).toBe(2500 + 1800) // the credit is not a run cost kind
    expect(m.contributionCents).toBe(75000 - 39000 - 4300)
    expect(m.hours.review).toBe(3)
    expect(m.label).toBe(CONTRIBUTION_LABEL)
    expect(monthlyContribution(A, '2026-09', rev, labor, costs, rates).collectedMonthlyCents).toBe(0)
  })

  it('ratios never divide by zero', () => {
    expect(reviewTimePerCase(5, 0)).toBeNull()
    expect(reviewTimePerCase(5, 4)).toBe(1.25)
    expect(costPerCompletedWorkflow(10000, 2000, 0)).toBeNull()
    expect(costPerCompletedWorkflow(10000, 2000, 4)).toBe(3000)
  })

  it('support time per agency, unassigned kept separate', () => {
    expect(supportTimePerAgency(labor)).toEqual({ [A]: 1.5, unassigned: 4 })
  })

  it('agency rollup separates collected, projected and mock and labels contribution', () => {
    const r = agencyRollup(A, rev, labor, costs, rates)
    expect(r.collectedCents).toBe(375000)
    expect(r.projectedCents).toBe(175000)
    expect(r.mockCount).toBe(2)
    expect(r.costCents).toBe(4000 + 2500 + 1800 - 500)
    expect(r.contributionCents).toBe(375000 - r.laborCents - r.costCents)
    expect(r.label).toBe('Contribution (not net profit; excludes unrecorded overhead)')
  })

  it('website: $500 vs hours × build rate; unpaid or mock-paid counts the price as 0', () => {
    expect(websiteContribution(50000, 3.5, rates, true)).toMatchObject({ laborValueCents: 35000, contributionCents: 15000, collected: true })
    expect(websiteContribution(50000, 3.5, rates, false).contributionCents).toBe(-35000)
  })

  it('formats cents as dollars', () => {
    expect(dollars(375000)).toBe('$3,750')
    expect(dollars(-4300)).toBe('−$43')
    expect(dollars(1250)).toBe('$12.5')
  })
})
