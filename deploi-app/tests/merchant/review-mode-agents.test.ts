/**
 * STORE_ACCESS_MODE=review limits only WHICH STORES may be written to. It must not loosen anything about WHAT an
 * agent may do there. Every test here runs on a real (non-synthetic) store that Shopify reports as a development
 * store, in review mode, so the store itself is eligible; the agent's own permission level, its version-bound grant,
 * and pause/revoke must still decide every write. (The synthetic transport stands in for Shopify.)
 */
import './env'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { approveProposal } from '../../lib/engine/approve'
import { executeProposal } from '../../lib/engine/execute'
import { createAgent, editAgent, grantPolicy, pauseAgent, resumeAgent, revokeAgent } from '../../lib/agents/lifecycle'
import { runAgent } from '../../lib/agents/run'
import { loadConnection } from '../../lib/engine/scan'
import { setTransportOverride } from '../../lib/connectors/shopify/client'
import { syntheticTransport } from '../../lib/connectors/shopify/synthetic'
import { getAccess, recordShopFacts } from '../../lib/engine/access'
import { NORTHWIND_IDS } from '../../lib/connectors/shopify/demo-store'
import { DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'
import type { Actor } from '../../lib/engine/actor'
import { NW, merchantActor, resetMerchant, store } from './helpers'

const ready = await prepareDb()
const { V } = NORTHWIND_IDS
const STOCK = { correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: DEFAULT_EXEMPT_TAGS, flagInStockVariants: true } } }
const UNTIL = new Date(Date.now() + 300 * 864e5).toISOString()
const writes = async () => (await store(NW))!.writeLog.length
const proposalFor = (agentId: string, target: string) =>
  admin(db => db.one<{ id: string; change_hash: string; status: string; status_reason: string | null }>(
    `select id, change_hash, status, status_reason from proposals where agent_id = $1 and target_id = $2 order by created_at desc limit 1`, [agentId, target]))

async function grantedAgent(actor: Actor, name: string, policy: Record<string, unknown>) {
  const c = await createAgent(actor, { name, taskText: `${name} task`, policy: { connectionId: NW.conn, productScope: { mode: 'all' }, ...STOCK, ...policy } })
  await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
  return c
}

describe.skipIf(!ready)('review mode limits stores, never agent permissions', () => {
  beforeEach(async () => {
    await resetMerchant(NW)
    process.env.STORE_ACCESS_MODE = 'review'
    setTransportOverride(conn => syntheticTransport(conn.id))
    await admin(db => db.query('update store_connections set is_synthetic = false where id = $1', [NW.conn]))
    const conn = (await admin(db => loadConnection(db, NW.conn)))!
    await admin(db => recordShopFacts(db, conn, { isDevelopmentStore: true, planName: 'Development' }, 'test'))
    // precondition for every test below: the store itself is enabled by review mode
    expect(await admin(db => getAccess(db, conn))).toMatchObject({ eligible: true, basis: 'development_store', mode: 'review' })
  })
  afterEach(async () => {
    delete process.env.STORE_ACCESS_MODE
    setTransportOverride(null)
    await admin(db => db.query('update store_connections set is_synthetic = true where id = $1', [NW.conn]))
  })

  it('an "after approval" agent on a development store still waits for approval; only the approved change is written', async () => {
    const actor = await merchantActor(NW)
    const c = await grantedAgent(actor, 'Reviewer', { approvalMode: 'review' })
    const before = await writes()
    const r = await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    expect(r.counts).toMatchObject({ proposed: 5, awaitingApproval: 5, autoApproved: 0 })
    expect(await writes()).toBe(before) // nothing written without approval, even though the store is enabled
    // executing an unapproved proposal is refused
    const pending = (await admin(db => db.one<{ id: string; status: string }>(`select id, status from proposals where agent_id = $1 and target_id <> $2 and status = 'pending_approval' limit 1`, [c.agentId, V(2001)])))!
    expect(pending.status).toBe('pending_approval')
    expect((await executeProposal(pending.id, { actor: actor.label })).status).toBe('not_approved')
    expect(await writes()).toBe(before)
    // approving one exact change writes that one change, verified
    const p = (await proposalFor(c.agentId, V(2001)))!
    await approveProposal(actor, p.id, p.change_hash)
    expect((await executeProposal(p.id, { actor: actor.label })).status).toBe('verified')
    expect(await writes()).toBe(before + 1)
  })

  it('a drafts-only agent writes nothing and its drafts cannot be approved', async () => {
    const actor = await merchantActor(NW)
    const c = await grantedAgent(actor, 'Drafter', { approvalMode: 'draft' })
    const before = await writes()
    const r = await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    expect(r.counts).toMatchObject({ drafted: 5, autoApproved: 0, awaitingApproval: 0 })
    const p = (await proposalFor(c.agentId, V(2001)))!
    expect(p.status_reason).toMatch(/^draft:/)
    await expect(approveProposal(actor, p.id, p.change_hash)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await writes()).toBe(before)
  })

  it('the grant is bound to the reviewed version: a wrong hash is refused, and widening needs a new grant (the old version keeps running)', async () => {
    const actor = await merchantActor(NW)
    const draft = await createAgent(actor, { name: 'Bound', taskText: '', policy: { connectionId: NW.conn, productScope: { mode: 'all' }, ...STOCK, approvalMode: 'draft' } })
    await expect(grantPolicy(actor, draft.agentId, draft.policyId, 'f'.repeat(64))).rejects.toMatchObject({ code: 'hash_mismatch' })
    await expect(runAgent(draft.agentId, { trigger: 'test', actor: actor.label })).rejects.toMatchObject({ code: 'agent_inactive' })
    await grantPolicy(actor, draft.agentId, draft.policyId, draft.policyHash)
    const e = await editAgent(actor, draft.agentId, { policy: { connectionId: NW.conn, productScope: { mode: 'all' }, ...STOCK, approvalMode: 'autonomous', validUntil: UNTIL } })
    expect(e.requiresGrant).toBe(true)
    const before = await writes()
    const r = await runAgent(draft.agentId, { trigger: 'test', actor: actor.label })
    expect(r.counts).toMatchObject({ drafted: 5, autoApproved: 0 }) // still the drafts-only version
    expect(await writes()).toBe(before)
  })

  it('"within limits" (autonomous) only acts under its own grant, and pause and revoke stop it', async () => {
    const actor = await merchantActor(NW)
    const c = await grantedAgent(actor, 'Guard', { approvalMode: 'autonomous', validUntil: UNTIL })
    await pauseAgent(actor, c.agentId)
    const before = await writes()
    await expect(runAgent(c.agentId, { trigger: 'test', actor: actor.label })).rejects.toMatchObject({ code: 'agent_inactive' })
    expect(await writes()).toBe(before)
    await resumeAgent(actor, c.agentId)
    const r = await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    expect(r.counts.autoApproved).toBeGreaterThan(0)
    expect(await writes()).toBeGreaterThan(before) // the standing grant, not review mode, is what lets it act
    await revokeAgent(actor, c.agentId)
    const afterRevoke = await writes()
    await expect(runAgent(c.agentId, { trigger: 'test', actor: actor.label })).rejects.toMatchObject({ code: 'agent_inactive' })
    expect(await writes()).toBe(afterRevoke)
  })

  it('the same agents on a real merchant store in review mode write nothing at all', async () => {
    const actor = await merchantActor(NW)
    const conn = (await admin(db => loadConnection(db, NW.conn)))!
    await admin(db => recordShopFacts(db, conn, { isDevelopmentStore: false, planName: 'Basic' }, 'test'))
    const c = await grantedAgent(actor, 'Guard', { approvalMode: 'autonomous', validUntil: UNTIL })
    const before = await writes()
    await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    expect(await writes()).toBe(before)
  })
})
