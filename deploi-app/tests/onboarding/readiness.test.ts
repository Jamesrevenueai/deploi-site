import './env'
import { describe, it, expect } from 'vitest'
import { DEFAULT_ITEMS, type OnboardingItemRow } from '../../lib/onboarding/checklist'
import { computeReadiness, gateFor, type ReadinessFacts } from '../../lib/onboarding/readiness'

const rows = (overrides: Record<string, Partial<OnboardingItemRow>> = {}): OnboardingItemRow[] => DEFAULT_ITEMS.map((d, i) => ({
  id: `i${i}`, engagement_id: 'e', agency_id: 'a', key: d.key, label: d.label, dimension: d.dimension, required: d.required, sort_order: i,
  completed_at: null, completed_by: null, note: null, evidence: null, ...(overrides[d.key] ?? {}),
}))
const allDone = (extra: Record<string, Partial<OnboardingItemRow>> = {}) => rows(Object.fromEntries(DEFAULT_ITEMS.map(d => [d.key, { completed_at: '2026-10-10T00:00:00Z', completed_by: 'u', evidence: { simulated: false }, ...(extra[d.key] ?? {}) }])))
const facts = (o: Partial<ReadinessFacts> = {}): ReadinessFacts => ({ baaSignedAt: '2026-10-01T00:00:00Z', pilot: { hasDates: true, hasPrimaryMetric: true, decision: null, baselineMeasurements: 3 }, ...o })

describe('onboarding readiness', () => {
  it('covers every dimension with required items and is not ready when nothing is done', () => {
    const r = computeReadiness(rows(), facts({ baaSignedAt: null }))
    expect(r.dimensions.map(d => d.dimension)).toEqual(['configuration', 'data_quality', 'security_controls', 'integration_verification', 'operational_readiness', 'commercial_readiness'])
    for (const d of r.dimensions) expect(d.required, d.dimension).toBeGreaterThan(0)
    expect(r.ready).toBe(false)
    expect(r.missing.length).toBe(DEFAULT_ITEMS.length)
  })
  it('agreements_recorded is auto-satisfied from the agency BAA date and labelled as not proof of compliance', () => {
    const r = computeReadiness(rows(), facts())
    const item = r.items.find(i => i.key === 'agreements_recorded')!
    expect(item.satisfied).toBe(true)
    expect(item.completed).toBe(false)
    expect(item.reason).toBe('BAA recorded; not proof of full compliance')
  })
  it('a simulated input test never satisfies "input source tested" or integration verification', () => {
    const r = computeReadiness(allDone({ input_source_tested: { evidence: { method: 'adapter_test', ok: true, simulated: true, mocked: true } } }), facts())
    const item = r.items.find(i => i.key === 'input_source_tested')!
    expect(item.completed).toBe(true)
    expect(item.satisfied).toBe(false)
    expect(r.dimensions.find(d => d.dimension === 'integration_verification')!.ready).toBe(false)
    expect(gateFor('testing', r, facts())).toEqual(['Input source tested (live, not simulated)'])
    expect(gateFor('pilot', r, facts())).toContain('Input source tested')
    // live evidence satisfies it
    const live = computeReadiness(allDone({ input_source_tested: { evidence: { method: 'adapter_test', ok: true, simulated: false, mocked: false } } }), facts())
    expect(gateFor('testing', live, facts())).toEqual([])
  })
  it('API-key presence never flips integration readiness; only recorded live evidence does', () => {
    const f = facts({ providerKeysPresent: { email: true, sms: true } })
    const r = computeReadiness(rows(), f)
    expect(r.dimensions.find(d => d.dimension === 'integration_verification')!.satisfied).toBe(0)
    expect(gateFor('testing', r, f)).toEqual(['Input source tested (live, not simulated)'])
    process.env.RESEND_API_KEY = 're_test_key_presence_only'
    try {
      const again = computeReadiness(rows(), f)
      expect(again.dimensions.find(d => d.dimension === 'integration_verification')!.satisfied).toBe(0)
    } finally { delete process.env.RESEND_API_KEY }
  })
  it('gates: building needs agreements + data access; pilot needs everything plus a pilot with dates and metric; active needs Continue/Expand', () => {
    const none = computeReadiness(rows(), facts({ baaSignedAt: null }))
    expect(gateFor('building', none, facts({ baaSignedAt: null })).sort()).toEqual(['Data access authorization', 'Required agreements recorded'].sort())
    const done = computeReadiness(allDone(), facts())
    expect(gateFor('building', done, facts())).toEqual([])
    expect(gateFor('pilot', done, facts({ pilot: null }))).toEqual(['A pilot with dates and a primary metric'])
    expect(gateFor('pilot', done, facts({ pilot: { hasDates: false, hasPrimaryMetric: false, decision: null, baselineMeasurements: 1 } }))).toEqual(['Pilot start and end dates', 'Pilot primary metric'])
    expect(gateFor('pilot', done, facts())).toEqual([])
    const missingOne = computeReadiness(allDone({ pilot_approval_recorded: { completed_at: null } }), facts())
    expect(gateFor('pilot', missingOne, facts())).toEqual(['Pilot approval recorded'])
    expect(gateFor('active', done, facts({ pilot: { hasDates: true, hasPrimaryMetric: true, decision: 'revise', baselineMeasurements: 1 } }))[0]).toMatch(/Continue or Expand/)
    expect(gateFor('active', done, facts({ pilot: { hasDates: true, hasPrimaryMetric: true, decision: 'continue', baselineMeasurements: 1 } }))).toEqual([])
    expect(gateFor('active', done, facts({ pilot: { hasDates: true, hasPrimaryMetric: true, decision: 'expand', baselineMeasurements: 1 } }))).toEqual([])
    expect(gateFor('paused', done, facts())).toEqual([])
  })
  it('baseline captured is not satisfied when the pilot has no baseline measurements', () => {
    const r = computeReadiness(allDone(), facts({ pilot: { hasDates: true, hasPrimaryMetric: true, decision: null, baselineMeasurements: 0 } }))
    expect(r.items.find(i => i.key === 'baseline_captured')!.satisfied).toBe(false)
  })
})
