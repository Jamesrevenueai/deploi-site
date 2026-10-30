/**
 * Agents do the work themselves. When the Inventory Watcher and the store's own check find the same
 * oversell problem, the agent acts first and its draft is the one the merchant sees; the store check is
 * the backup for records no agent has in hand. The weekly summary credits the agent for the fix.
 */
import './env'
import { describe, it, expect, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { createAgent, grantPolicy } from '../../lib/agents/lifecycle'
import { runAgent } from '../../lib/agents/run'
import { templatePolicy } from '../../lib/agents/templates'
import { weeklyFacts, weekStartOf } from '../../lib/agents/weekly'
import { runScan } from '../../lib/engine/scan'
import { approveAndExecute } from '../../lib/engine/execute'
import type { Actor } from '../../lib/engine/actor'
import { SET_POLICY_ACTION } from '../../lib/connectors/shopify/checks'
import { NW, merchantActor, resetMerchant, store } from './helpers'

const ready = await prepareDb()
const OVERSELL = SET_POLICY_ACTION

async function inventoryWatcher(actor: Actor) {
  // the template exactly as a merchant starts it, widened to "after my approval" so a fix can be made
  // (its email alerts need a connected mailbox; this test is about the store changes, so they are left out)
  const { email: _email, ...policy }: Record<string, unknown> = { ...templatePolicy('inventory_watcher', { connectionId: NW.conn, timezone: 'UTC', notify: NW.email }), approvalMode: 'review' }
  const c = await createAgent(actor, { name: 'Inventory Watcher', taskText: 'Every day, check my inventory for overselling.', policy })
  await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
  return c.agentId
}

const pending = (owner: 'agent' | 'store') => admin(db => db.query<{ id: string; change_hash: string; target_id: string; agent_id: string | null }>(
  `select id, change_hash, target_id, agent_id from proposals where connection_id = $1 and status = 'pending_approval' and agent_id is ${owner === 'agent' ? 'not' : ''} null order by target_id`, [NW.conn]))
const conflicts = () => admin(db => db.one<{ n: string }>(`select count(*)::text as n from issues where connection_id = $1 and status_reason = 'conflicting_agent'`, [NW.conn]))

describe.skipIf(!ready)('agent first, store check as backup', () => {
  beforeEach(async () => { await resetMerchant(NW, { ruleOn: true }) })

  it('the Inventory Watcher drafts the oversell fixes on its own before the store check has run, and the store check then stands back', async () => {
    const actor = await merchantActor(NW)
    const agentId = await inventoryWatcher(actor)
    const r = await runAgent(agentId, { trigger: 'test', actor: actor.label })
    expect(r.status).toBe('completed')
    const mine = await pending('agent')
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every(p => p.agent_id === agentId)).toBe(true)

    await runScan(NW.conn, { trigger: 'manual', actor: 'test' })
    expect(await pending('store')).toHaveLength(0)
    expect((await pending('agent')).map(p => p.id)).toEqual(mine.map(p => p.id))
    expect((await conflicts())!.n).toBe('0')
  })

  it('when the store check drafted first, the agent takes the unapproved drafts over, makes the approved fix, and the weekly summary credits the agent', async () => {
    const actor = await merchantActor(NW)
    await runScan(NW.conn, { trigger: 'manual', actor: 'test' })
    const storeDrafts = await pending('store')
    expect(storeDrafts.length).toBeGreaterThan(0)

    const agentId = await inventoryWatcher(actor)
    await runAgent(agentId, { trigger: 'test', actor: actor.label })
    const agentDrafts = await pending('agent')
    expect(await pending('store')).toHaveLength(0)
    expect(agentDrafts.map(p => p.target_id)).toEqual(expect.arrayContaining(storeDrafts.map(p => p.target_id)))
    const superseded = await admin(db => db.query<{ status: string; status_reason: string }>('select status, status_reason from proposals where id = any($1::uuid[])', [storeDrafts.map(p => p.id)]))
    expect(superseded.every(p => p.status === 'superseded' && /agent covering this record/.test(p.status_reason))).toBe(true)
    expect((await conflicts())!.n).toBe('0')

    const before = (await store(NW))!.writeLog.length
    const target = agentDrafts[0]
    const done = await approveAndExecute(actor, target.id, target.change_hash)
    expect(done.status).toBe('verified')
    expect((await store(NW))!.writeLog.length).toBe(before + 1)

    const facts = await admin(db => weeklyFacts(db, NW.org, weekStartOf(new Date())))
    expect(facts.agents.find(a => a.agentId === agentId)).toMatchObject({ verified: 1 })
  })

  it('with no agent covering the records, the store check still drafts the fix (backup)', async () => {
    await runScan(NW.conn, { trigger: 'manual', actor: 'test' })
    const drafts = await pending('store')
    expect(drafts.length).toBeGreaterThan(0)
    const actions = await admin(db => db.query<{ action_key: string }>('select distinct action_key from proposals where id = any($1::uuid[])', [drafts.map(p => p.id)]))
    expect(actions.map(a => a.action_key)).toContain(OVERSELL)
  })
})
