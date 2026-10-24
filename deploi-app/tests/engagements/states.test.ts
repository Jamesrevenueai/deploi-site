import './env'
import { describe, it, expect } from 'vitest'
import { STATUSES, TRANSITIONS, canTransition, nextStatuses, POST_ACCEPTANCE, isAcceptanceEvidence } from '../../lib/engagements/states'
import { proposalDefaults, parseVolume, EngagementServiceError } from '../../lib/engagements/defaults'
import { getPricing } from '../../lib/catalog/pricing'
import { getService } from '../../lib/catalog/services'

describe('engagement state table', () => {
  it('lists every status exactly once and every transition targets a known status', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...STATUSES].sort())
    for (const [from, tos] of Object.entries(TRANSITIONS)) for (const to of tos) {
      expect(STATUSES).toContain(to)
      expect(to, `${from} -> ${to}`).not.toBe(from)
    }
  })
  it('follows the forward path draft → proposed → accepted → building → testing → pilot → active → completed', () => {
    const path = ['draft', 'proposed', 'accepted', 'building', 'testing', 'pilot', 'active', 'completed'] as const
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`).toBe(true)
  })
  it('paused ↔ active, and completed is terminal', () => {
    expect(canTransition('active', 'paused')).toBe(true)
    expect(canTransition('paused', 'active')).toBe(true)
    expect(nextStatuses('completed')).toEqual([])
  })
  it('nothing skips accepted: no pre-acceptance status can reach building or later directly', () => {
    for (const from of ['draft', 'proposed'] as const) for (const to of POST_ACCEPTANCE.filter(s => s !== 'accepted')) expect(canTransition(from, to), `${from} -> ${to}`).toBe(false)
    // and the only ways into accepted are forward from proposed or back from building
    for (const from of STATUSES) if (from !== 'proposed' && from !== 'building') expect(canTransition(from, 'accepted'), `${from} -> accepted`).toBe(false)
    // no status before accepted is reachable except through the explicit back-steps
    expect(canTransition('draft', 'pilot')).toBe(false)
    expect(canTransition('testing', 'active')).toBe(false)
    expect(canTransition('building', 'pilot')).toBe(false)
  })
  it('allows only the explicit back-transitions', () => {
    expect(canTransition('proposed', 'draft')).toBe(true)
    expect(canTransition('accepted', 'proposed')).toBe(true)
    expect(canTransition('building', 'accepted')).toBe(true)
    expect(canTransition('testing', 'building')).toBe(true)
    expect(canTransition('pilot', 'testing')).toBe(true)
    expect(canTransition('active', 'pilot')).toBe(false)
    expect(canTransition('completed', 'active')).toBe(false)
  })
  it('validates acceptance evidence shape', () => {
    expect(isAcceptanceEvidence({ method: 'email', reference: 'msg-1', accepted_by: 'Owner', accepted_at: '2026-10-01T10:00:00Z', recorded_by: null })).toBe(true)
    expect(isAcceptanceEvidence({ method: 'carrier_pigeon', reference: 'x', accepted_by: 'Owner', accepted_at: '2026-10-01', recorded_by: null })).toBe(false)
    expect(isAcceptanceEvidence({ method: 'email', reference: 'x', accepted_by: '', accepted_at: '2026-10-01', recorded_by: null })).toBe(false)
    expect(isAcceptanceEvidence({ method: 'email', reference: 'x', accepted_by: 'Owner', accepted_at: 'yesterday', recorded_by: null })).toBe(false)
    expect(isAcceptanceEvidence(null)).toBe(false)
  })
})

describe('proposal defaults from the catalog', () => {
  it('prefills fees at the minimum of the published ranges, exclusions and volume from the service', () => {
    const p = getPricing()
    const d = proposalDefaults('referral_response')
    expect(d.setup_fee_cents).toBe(p.build.min * 100)
    expect(d.monthly_fee_cents).toBe(p.management.min * 100)
    expect(d.exclusions).toEqual(getService('referral_response')!.exclusions)
    expect(d.included_volume).toBe(60)
    expect(d.volume_units).toBe('referrals per month')
    expect(d.fix_period_days).toBe(p.build.fixPeriodDays)
    expect(d.initial_term_months).toBe(p.management.initialTermMonths)
    expect(d.input_method).toBe('email_inbox')
    expect(d.milestones.length).toBe(getService('referral_response')!.setupDeliverables.length)
    expect(d.acceptance_criteria.some(c => /Median time to first response/.test(c))).toBe(true)
  })
  it('parses the volume limits of every non-standalone service', () => {
    expect(parseVolume('Up to 3,000 visits per month in the base fee')).toEqual({ volume: 3000, units: 'visits per month' })
    expect(parseVolume('Up to 150 active aides in the base fee')).toEqual({ volume: 150, units: 'active aides' })
    expect(parseVolume(undefined)).toEqual({ volume: null, units: null })
  })
  it('refuses standalone and unknown services', () => {
    expect(() => proposalDefaults('website_improvement')).toThrow(EngagementServiceError)
    expect(() => proposalDefaults('nope')).toThrow(EngagementServiceError)
  })
})
