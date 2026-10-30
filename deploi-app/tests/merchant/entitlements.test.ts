/**
 * Free-beta plan limits, enforced on the server when an agent is created or widened: the number of agents per
 * organization and the competitor stores watched across it. No price, no billing.
 */
import './env'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { createAgent, editAgent } from '../../lib/agents/lifecycle'
import { DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'
import { entitlements } from '../../lib/plans/entitlements'
import { NW, HB, merchantActor, resetMerchant } from './helpers'

const ready = await prepareDb()
const base = (conn: string) => ({ connectionId: conn, productScope: { mode: 'all' }, correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: DEFAULT_EXEMPT_TAGS, flagInStockVariants: true } } })
const inventory = () => base(NW.conn)
const watcher = (n: number) => ({ ...inventory(), competitors: { stores: Array.from({ length: n }, (_, i) => ({ url: `https://rival${i}.example` })), keywords: [], alerts: ['launches'], cadence: 'daily' } })

describe('plan entitlements (free beta)', () => {
  afterEach(() => { delete process.env.PLAN_MAX_AGENTS; delete process.env.PLAN_MAX_COMPETITOR_STORES })
  it('defaults to an unpriced free beta with configurable limits', () => {
    expect(entitlements()).toMatchObject({ plan: 'beta_free', priced: false, maxAgents: 10, maxCompetitorStores: 25 })
    process.env.PLAN_MAX_AGENTS = '3'
    expect(entitlements().maxAgents).toBe(3)
  })
})

describe.skipIf(!ready)('plan limits are enforced on the server', () => {
  beforeEach(async () => { await resetMerchant(NW, { ruleOn: false }); await resetMerchant(HB, { ruleOn: false }) })
  afterEach(() => { delete process.env.PLAN_MAX_AGENTS; delete process.env.PLAN_MAX_COMPETITOR_STORES })

  it('refuses an agent beyond the cap, per organization', async () => {
    process.env.PLAN_MAX_AGENTS = '2'
    const actor = await merchantActor(NW)
    await createAgent(actor, { name: 'One', taskText: '', policy: inventory() })
    await createAgent(actor, { name: 'Two', taskText: '', policy: inventory() })
    await expect(createAgent(actor, { name: 'Three', taskText: '', policy: inventory() })).rejects.toThrow(/allows 2 agents/)
    // another organization has its own allowance
    const hb = await merchantActor(HB)
    await expect(createAgent(hb, { name: 'Harbor one', taskText: '', policy: base(HB.conn) })).resolves.toBeTruthy()
  })

  it('caps the competitor stores watched across the organization, on create and on widening', async () => {
    process.env.PLAN_MAX_COMPETITOR_STORES = '3'
    const actor = await merchantActor(NW)
    await expect(createAgent(actor, { name: 'Too many', taskText: '', policy: watcher(4) })).rejects.toThrow(/allows 3 watched competitor stores/)
    const ok = await createAgent(actor, { name: 'Two stores', taskText: '', policy: watcher(2) })
    await expect(createAgent(actor, { name: 'Two more', taskText: '', policy: watcher(2) })).rejects.toThrow(/allows 3 watched competitor stores in total \(this would make 4\)/)
    await expect(editAgent(actor, ok.agentId, { policy: watcher(4) })).rejects.toThrow(/allows 3 watched competitor stores/)
  })
})
