/**
 * Task wording edge cases found while seeding the demo: "overselling" must be understood, and a task
 * that only says when (a schedule) but not what is refused rather than queued (fail closed).
 */
import './env'
import { describe, it, expect, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { parseTask } from '../../lib/agents/parse'
import { createAgent, grantPolicy } from '../../lib/agents/lifecycle'
import { assignTask } from '../../lib/agents/tasks'
import { NW, merchantActor, resetMerchant } from './helpers'
import { DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'

const ready = await prepareDb()
beforeEach(async () => { if (ready) await resetMerchant(NW) })

describe('task wording', () => {
  it('understands overselling, oversold and backorders', () => {
    for (const t of ['Check overselling', 'Find oversold products', 'Stop backorders']) expect(parseTask(t).correctionTypes, t).toContain('oversell_policy')
  })
})

describe.skipIf(!ready)('tasks fail closed', () => {
  it('a schedule alone is refused; a scoped oversell check inside the rules is queued', async () => {
    const actor = await merchantActor(NW)
    const c = await createAgent(actor, { name: 'Guard', taskText: '', policy: { connectionId: NW.conn, productScope: { mode: 'tags', tags: ['home'] }, correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: DEFAULT_EXEMPT_TAGS, flagInStockVariants: true } } } })
    await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
    expect((await assignTask(actor, c.agentId, 'Post our new arrivals on Instagram every morning')).status).toBe('refused')
    expect((await assignTask(actor, c.agentId, 'Check overselling now on products tagged home.')).status).toBe('queued')
  })
})
