import { describe, it, expect } from 'vitest'
import { LIBRARY, validateLibrary, tierIncludes, lowestTierFor, agentByKey, DEFAULT_PERMISSION } from '../../lib/library/config'
import { RUNNERS, runnerCoverageProblems, matchCapabilities } from '../../lib/library/runners'
import { allTierEconomics, costPerAction, monthlyBill, tokensFor, ACTION_TOKENS } from '../../lib/library/pricing'
import { APPROVAL_ONLY } from '../../lib/library/actions'
import { ACTION_MINUTES } from '../../lib/library/weekly'

const EXPECTED = {
  starter: ['inventory_watcher', 'store_health_checker', 'weekly_insights', 'listing_writer'],
  growth: ['supplier_chaser', 'order_tracker', 'promo_manager', 'ai_visibility'],
  pro: ['customer_care', 'campaign', 'returns', 'payout_fees_checker'],
}

describe('agent library config (the one file the app and the site share)', () => {
  it('is valid, has twelve agents, and every agent is in a tier', () => {
    expect(validateLibrary()).toEqual([])
    expect(LIBRARY.agents).toHaveLength(12)
    expect(new Set(LIBRARY.agents.map(a => a.key)).size).toBe(12)
    for (const a of LIBRARY.agents) expect(lowestTierFor(a.key)).not.toBeNull()
  })
  it('tiers nest: Starter 4, Growth +4, Pro all 12, Pro alone has build your own', () => {
    const t = Object.fromEntries(LIBRARY.tiers.map(x => [x.key, x]))
    expect(t.starter.agents.sort()).toEqual([...EXPECTED.starter].sort())
    expect(t.growth.agents.sort()).toEqual([...EXPECTED.starter, ...EXPECTED.growth].sort())
    expect(t.pro.agents.sort()).toEqual([...EXPECTED.starter, ...EXPECTED.growth, ...EXPECTED.pro].sort())
    expect(t.starter.buildYourOwn).toBe(false); expect(t.growth.buildYourOwn).toBe(false); expect(t.pro.buildYourOwn).toBe(true)
    for (const k of EXPECTED.pro) { expect(tierIncludes('starter', k)).toBe(false); expect(tierIncludes('growth', k)).toBe(false); expect(lowestTierFor(k)?.key).toBe('pro') }
    for (const k of EXPECTED.growth) { expect(tierIncludes('starter', k)).toBe(false); expect(lowestTierFor(k)?.key).toBe('growth') }
    for (const k of EXPECTED.starter) expect(lowestTierFor(k)?.key).toBe('starter')
  })
  it('tier membership is data: moving an agent is a config edit the code follows', () => {
    const copy = structuredClone(LIBRARY)
    copy.tiers.find(t => t.key === 'starter')!.agents.push('order_tracker')
    expect(validateLibrary(copy)).toEqual([])
    const broken = structuredClone(LIBRARY)
    broken.tiers.find(t => t.key === 'growth')!.agents = broken.tiers.find(t => t.key === 'growth')!.agents.filter(k => k !== 'listing_writer')
    expect(validateLibrary(broken).join(' ')).toMatch(/lacks listing_writer/)
  })
  it('every agent has a runner, a character, a plain-English example, scopes, and at least one action type', () => {
    expect(runnerCoverageProblems()).toEqual([])
    for (const a of LIBRARY.agents) {
      expect(RUNNERS[a.key], a.key).toBeTypeOf('function')
      expect(a.character.emoji.length).toBeGreaterThan(0)
      expect(a.exampleTask.length).toBeGreaterThan(20)
      expect(a.scopes.length).toBeGreaterThan(0)
      expect(a.actionTypes.length).toBeGreaterThan(0)
      for (const t of a.actionTypes) { expect(ACTION_TOKENS[t.key], `${a.key}.${t.key} cost`).toBeDefined(); expect(ACTION_MINUTES[t.key], `${a.key}.${t.key} minutes`).toBeDefined() }
    }
  })
  it('the three existing agents are template-backed; the nine new ones are library-only', () => {
    expect(LIBRARY.agents.filter(a => a.status === 'existing').map(a => a.key).sort()).toEqual(['inventory_watcher', 'store_health_checker', 'supplier_chaser'])
    for (const a of LIBRARY.agents) expect(Boolean(a.templateKey)).toBe(a.status === 'existing')
  })
  it('protected customer data scopes are flagged only on the agents that read orders, customers or returns', () => {
    const withProtected = LIBRARY.agents.filter(a => a.protectedScopes.length).map(a => a.key).sort()
    expect(withProtected).toEqual(['customer_care', 'order_tracker', 'payout_fees_checker', 'returns', 'weekly_insights'])
    for (const k of ['listing_writer', 'inventory_watcher', 'ai_visibility', 'promo_manager', 'campaign']) expect(agentByKey(k)!.scopes.some(s => /customer|order|return/.test(s))).toBe(false)
  })
  it('every agent starts at draft-for-approval; money and publishing actions are approval-only', () => {
    expect(DEFAULT_PERMISSION).toBe('draft')
    expect([...APPROVAL_ONLY].sort()).toEqual(['approve_return', 'create_discount', 'end_discount', 'send_customer_reply'])
    for (const k of APPROVAL_ONLY) expect(LIBRARY.agents.some(a => a.actionTypes.some(t => t.key === k && t.writes))).toBe(true)
  })
  it('pricing: proposed prices leave a high margin over the estimated model cost at the full allowance and on overage', () => {
    for (const e of allTierEconomics()) {
      expect(e.grossMarginAtFullAllowance).toBeGreaterThan(0.8)
      expect(e.overageMargin).toBeGreaterThan(0.8)
      expect(e.costPerActionUsd).toBeGreaterThan(0)
    }
    expect(costPerAction('draft_campaign_email')).toBeGreaterThan(costPerAction('flag_oversold'))
    expect(tokensFor('something_unknown')).toEqual(ACTION_TOKENS.custom_agent_run)
    const starter = LIBRARY.tiers[0]
    expect(monthlyBill(starter, starter.monthlyActions)).toMatchObject({ overageActions: 0, overage: 0, total: starter.proposedPriceUsd })
    expect(monthlyBill(starter, starter.monthlyActions + 10)).toMatchObject({ overageActions: 10, overage: Math.round(10 * starter.proposedOverageUsd * 100) / 100 })
    expect(LIBRARY.pricingStatus).toBe('coming_soon')
  })
  it('build your own: a job description maps to library capabilities', () => {
    expect(matchCapabilities('Tell me which orders are late and draft a note to the customer')).toEqual(expect.arrayContaining(['order_tracker', 'customer_care']))
    expect(matchCapabilities('Watch my payouts and fees')).toEqual(['payout_fees_checker'])
    expect(matchCapabilities('Compose a haiku')).toEqual([])
  })
})
