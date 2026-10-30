import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { NW, merchantActor, resetMerchant } from '../merchant/helpers'
import { createAgent } from '../../lib/agents/lifecycle'
import { entitlements } from '../../lib/plans/entitlements'
import { DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'

const ready = await prepareDb()
const policy = () => ({ connectionId: NW.conn, productScope: { mode: 'all' }, correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: DEFAULT_EXEMPT_TAGS, flagInStockVariants: true } }, schedule: { kind: 'manual' }, approvalMode: 'draft' })

describe.skipIf(!ready)('free-beta entitlements', () => {
  beforeEach(() => resetMerchant(NW))
  afterEach(() => { delete process.env.PLAN_MAX_AGENTS })
  it('defaults to the free beta with 10 agents and 25 competitor stores', () => {
    expect(entitlements()).toEqual({ plan: 'beta_free', label: 'Free beta', priced: false, maxAgents: 10, maxCompetitorStores: 25 })
  })
  it('refuses an agent beyond PLAN_MAX_AGENTS, on the server', async () => {
    process.env.PLAN_MAX_AGENTS = '2'
    const actor = await merchantActor(NW)
    await createAgent(actor, { name: 'One', taskText: 'x', policy: policy() })
    await createAgent(actor, { name: 'Two', taskText: 'x', policy: policy() })
    await expect(createAgent(actor, { name: 'Three', taskText: 'x', policy: policy() })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
