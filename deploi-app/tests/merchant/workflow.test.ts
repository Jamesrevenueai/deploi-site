import './env'
import { describe, it, expect, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { runScan } from '../../lib/engine/scan'
import { approveProposal } from '../../lib/engine/approve'
import { executeProposal, retryExecution } from '../../lib/engine/execute'
import { confirmReproposal, dismissIssue, exemptProduct } from '../../lib/engine/review'
import { updateRule } from '../../lib/engine/rules'
import { listIssues } from '../../lib/engine/queries'
import { mutateSynthetic, injectFault } from '../../lib/connectors/shopify/synthetic'
import { NORTHWIND_IDS } from '../../lib/connectors/shopify/demo-store'
import { setTransportOverride } from '../../lib/connectors/shopify/client'
import { NW, HB, merchantActor, staffActor, resetMerchant, store } from './helpers'

const ready = await prepareDb()
const { V, P } = NORTHWIND_IDS

type P = { id: string; change_hash: string; status: string; status_reason: string | null; target_id: string; issue_id: string }
const proposalFor = (variant: string) => admin(db => db.one<P>(`select id, change_hash, status, status_reason, target_id, issue_id from proposals where connection_id = $1 and target_id = $2 order by created_at desc limit 1`, [NW.conn, variant]))
const policyOf = async (variant: string) => (await store(NW))!.products.flatMap(p => p.variants).find(v => v.id === variant)!.inventoryPolicy
const writes = async () => (await store(NW))!.writeLog.length
const setVariant = (variant: string, patch: { inventoryPolicy?: 'CONTINUE' | 'DENY'; tags?: string[]; status?: 'ACTIVE' | 'DRAFT'; available?: number }) =>
  mutateSynthetic(NW.conn, s => {
    const p = s.products.find(x => x.variants.some(v => v.id === variant))!
    const v = p.variants.find(x => x.id === variant)!
    if (patch.inventoryPolicy) v.inventoryPolicy = patch.inventoryPolicy
    if (patch.tags) p.tags = patch.tags
    if (patch.status) p.status = patch.status
    if (patch.available !== undefined) { v.levels[0].available = patch.available; v.levels[0].onHand = Math.max(0, patch.available); v.levels[0].committed = patch.available < 0 ? -patch.available : 0 }
  })

describe.skipIf(!ready)('merchant engine: detect, propose, approve, execute, verify', () => {
  beforeEach(async () => { await resetMerchant(NW); await resetMerchant(HB, { ruleOn: false }) })

  it('a scan opens exactly the expected issues and one proposal per correctable issue; rescans are idempotent', async () => {
    const s1 = await runScan(NW.conn, { trigger: 'test' })
    expect(s1).toMatchObject({ resourcesScanned: 19, issuesOpened: 6, proposalsCreated: 5 })
    const s2 = await runScan(NW.conn, { trigger: 'test' })
    expect(s2).toMatchObject({ issuesOpened: 0, issuesUpdated: 6, proposalsCreated: 0, proposalsInvalidated: 0 })
    const live = await admin(db => db.one<{ n: string }>(`select count(*)::text as n from proposals where connection_id = $1 and status = 'pending_approval'`, [NW.conn]))
    expect(Number(live!.n)).toBe(5)
    // the oversell rule is off for Harbor until its owner answers the setup question: nothing to flag
    expect((await runScan(HB.conn, { trigger: 'test' })).issuesOpened).toBe(0)
  })

  it('happy path: approve the exact change, it is written once and verified by a fresh read; the issue resolves', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const p = (await proposalFor(V(2001)))!
    const actor = await merchantActor(NW)
    const before = await writes()
    await approveProposal(actor, p.id, p.change_hash)
    const r = await executeProposal(p.id, { actor: actor.label })
    expect(r.status).toBe('verified')
    expect(await policyOf(V(2001))).toBe('DENY')
    expect(await writes()).toBe(before + 1)
    const issue = await admin(db => db.one<{ status: string; resolution: string }>('select status, resolution from issues where id = $1', [p.issue_id]))
    expect(issue).toEqual({ status: 'resolved', resolution: 'verified_fix' })
    const events = (await admin(db => db.query<{ event: string }>(`select event from engine_audit where entity_id = any($1::text[]) order by id`, [[p.id, r.executionId!, p.issue_id]]))).map(e => e.event)
    expect(events).toEqual(expect.arrayContaining(['issue.detected', 'proposal.created', 'execution.started', 'execution.applied', 'execution.verified']))
    // running it again is a no-op that returns the same execution (one approval, one execution)
    const again = await executeProposal(p.id, { actor: actor.label })
    expect(again).toMatchObject({ executionId: r.executionId, duplicate: true })
    expect(await writes()).toBe(before + 1)
  })

  it('approval is bound to the exact change: wrong hash, staff, another organization and unapproved runs are refused', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const p = (await proposalFor(V(2003)))!
    await expect(approveProposal(await merchantActor(NW), p.id, 'f'.repeat(64))).rejects.toMatchObject({ code: 'hash_mismatch' })
    await expect(approveProposal(await staffActor(), p.id, p.change_hash)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(approveProposal(await merchantActor(HB), p.id, p.change_hash)).rejects.toMatchObject({ code: 'not_found' })
    const r = await executeProposal(p.id, { actor: 'test' })
    expect(r.status).toBe('not_approved')
    expect(await policyOf(V(2003))).toBe('CONTINUE')
  })

  it('stale data: an outside change between approval and execution stops the write', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const actor = await merchantActor(NW)
    // 1. merchant tags the product as a pre-order after the proposal: the check no longer proposes this change
    let p = (await proposalFor(V(2004)))!
    await approveProposal(actor, p.id, p.change_hash)
    await setVariant(V(2004), { tags: ['pre-order'] })
    const before = await writes()
    let r = await executeProposal(p.id, { actor: actor.label })
    expect(r).toMatchObject({ status: 'stale' })
    expect(await writes()).toBe(before)
    // 2. someone already switched it off in Shopify: nothing to write, the issue closes
    p = (await proposalFor(V(2011)))!
    await approveProposal(actor, p.id, p.change_hash)
    await setVariant(V(2011), { inventoryPolicy: 'DENY' })
    r = await executeProposal(p.id, { actor: actor.label })
    expect(r).toMatchObject({ status: 'stale', reason: 'already in the proposed state' })
    // 3. product moved to draft: a precondition fails
    p = (await proposalFor(V(2013)))!
    await approveProposal(actor, p.id, p.change_hash)
    await setVariant(V(2013), { status: 'DRAFT' })
    r = await executeProposal(p.id, { actor: actor.label })
    expect(r).toMatchObject({ status: 'stale', reason: 'records changed since approval' })
    expect(await policyOf(V(2013))).toBe('CONTINUE')
    // stale approvals are revoked
    const active = await admin(db => db.one<{ n: string }>(`select count(*)::text as n from approvals where proposal_id = $1 and revoked_at is null`, [p.id]))
    expect(Number(active!.n)).toBe(0)
  })

  it('stale proposals are invalidated: rescans supersede changed proposals, expiry and rule changes refuse approval', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const actor = await merchantActor(NW)
    const old = (await proposalFor(V(2001)))!
    await admin(db => updateRule(db, { connectionId: NW.conn, checkKey: 'shopify.oversell_policy', config: { exemptTags: ['pre-order'], exemptProductIds: [], flagInStockVariants: true }, actor: 'test' }))
    await expect(approveProposal(actor, old.id, old.change_hash)).rejects.toMatchObject({ code: 'rule_changed' })
    await runScan(NW.conn, { trigger: 'test' })
    const fresh = (await proposalFor(V(2001)))!
    expect(fresh.id).not.toBe(old.id)
    expect(fresh.change_hash).not.toBe(old.change_hash)
    await admin(db => db.query(`update proposals set expires_at = now() - interval '1 minute' where id = $1`, [fresh.id]))
    await expect(approveProposal(actor, fresh.id, fresh.change_hash)).rejects.toMatchObject({ code: 'expired' })
    // the 'Backorder' product is no longer exempt under the new rule, so the rescan proposed it
    expect(await proposalFor(V(2014))).not.toBeNull()
  })

  it('retries: a refusal fails cleanly and a retry under the same approval succeeds without double writes', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const actor = await merchantActor(NW)
    const p = (await proposalFor(V(2001)))!
    await approveProposal(actor, p.id, p.change_hash)
    await injectFault(NW.conn, { op: 'DeploiSetInventoryPolicy', mode: 'user_error' })
    const r1 = await executeProposal(p.id, { actor: actor.label })
    expect(r1.status).toBe('failed')
    expect(await policyOf(V(2001))).toBe('CONTINUE')
    const r2 = await retryExecution(actor, r1.executionId!)
    expect(r2.status).toBe('verified')
    expect(r2.executionId).toBe(r1.executionId)
    const e = await admin(db => db.one<{ attempt: number }>('select attempt from executions where id = $1', [r1.executionId]))
    expect(e!.attempt).toBe(2)
    await expect(retryExecution(actor, r1.executionId!)).rejects.toMatchObject({ code: 'not_retryable' })
    await expect(retryExecution(await merchantActor(HB), r1.executionId!)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('outcome verification: lost responses and writes that do not stick are never reported as success', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const actor = await merchantActor(NW)
    const run = async (variant: string, mode: 'lost_response_applied' | 'lost_response_not_applied' | 'write_does_not_stick') => {
      const p = (await proposalFor(variant))!
      await approveProposal(actor, p.id, p.change_hash)
      await injectFault(NW.conn, { op: 'DeploiSetInventoryPolicy', mode })
      return executeProposal(p.id, { actor: actor.label })
    }
    expect((await run(V(2001), 'lost_response_applied')).status).toBe('verified')
    const notApplied = await run(V(2003), 'lost_response_not_applied')
    expect(notApplied).toMatchObject({ status: 'failed', reason: 'not applied' })
    expect((await run(V(2011), 'write_does_not_stick')).status).toBe('verification_failed')
    expect(await policyOf(V(2011))).toBe('CONTINUE')
    // the not-applied one can be retried safely
    expect((await retryExecution(actor, notApplied.executionId!)).status).toBe('verified')
  })

  it('duplicate prevention: concurrent executions write once; a second live proposal for a target is impossible', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const actor = await merchantActor(NW)
    const p = (await proposalFor(V(2004)))!
    await approveProposal(actor, p.id, p.change_hash)
    const before = await writes()
    const [a, b] = await Promise.all([executeProposal(p.id, { actor: 'a' }), executeProposal(p.id, { actor: 'b' })])
    expect(await writes()).toBe(before + 1)
    expect([a.status, b.status]).toContain('verified')
    const dup = admin(db => db.query(`insert into proposals (org_id, connection_id, issue_id, platform, action_key, target_type, target_id, change, preconditions, change_hash, expires_at)
      select org_id, connection_id, issue_id, platform, action_key, target_type, target_id, change, preconditions, 'x', now() + interval '1 day' from proposals where connection_id = $1 and target_id = $2 and status = 'pending_approval' limit 1`, [NW.conn, V(2013)]))
    await expect(dup).rejects.toThrow(/proposals_live_target/)
  })

  it('loop guard: if a verified fix is changed back, Deploi asks a person instead of flipping it again', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const actor = await merchantActor(NW)
    const p = (await proposalFor(V(2001)))!
    await approveProposal(actor, p.id, p.change_hash)
    expect((await executeProposal(p.id, { actor: actor.label })).status).toBe('verified')
    await setVariant(V(2001), { inventoryPolicy: 'CONTINUE' })
    const s = await runScan(NW.conn, { trigger: 'test' })
    expect(s.proposalsCreated).toBe(0)
    const issue = await admin(db => db.one<{ id: string; status: string; status_reason: string }>(`select id, status, status_reason from issues where connection_id = $1 and resource_id = $2 and status in ('open','needs_review')`, [NW.conn, V(2001)]))
    expect(issue).toMatchObject({ status: 'needs_review', status_reason: 'reverted_after_fix' })
    await confirmReproposal(actor, issue!.id)
    expect((await runScan(NW.conn, { trigger: 'test' })).proposalsCreated).toBe(1)
  })

  it('gates block without writing: live-store writes disabled, missing permission, billing required', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const actor = await merchantActor(NW)
    const before = await writes()
    // a non-synthetic connection is a real store: writes are refused until the store is enabled (beta access)
    const { syntheticTransport } = await import('../../lib/connectors/shopify/synthetic')
    setTransportOverride(conn => syntheticTransport(conn.id))
    try {
      await admin(db => db.query('update store_connections set is_synthetic = false where id = $1', [NW.conn]))
      let p = (await proposalFor(V(2001)))!
      await approveProposal(actor, p.id, p.change_hash)
      expect(await executeProposal(p.id, { actor: actor.label })).toMatchObject({ status: 'blocked', reason: 'this store is not enabled for changes yet (beta access)' })
      await admin(db => db.query(`update store_connections set is_synthetic = true, scopes = '{read_products,read_inventory}' where id = $1`, [NW.conn]))
      p = (await proposalFor(V(2003)))!
      await approveProposal(actor, p.id, p.change_hash)
      expect(await executeProposal(p.id, { actor: actor.label })).toMatchObject({ status: 'blocked', reason: 'missing permission: write_products' })
      await admin(db => db.query(`update store_connections set scopes = '{read_products,write_products,read_inventory,read_locations}' where id = $1`, [NW.conn]))
      process.env.BILLING_REQUIRED = 'true'
      await admin(db => db.query(`update app_subscriptions set status = 'cancelled' where connection_id = $1`, [NW.conn]))
      p = (await proposalFor(V(2011)))!
      await approveProposal(actor, p.id, p.change_hash)
      expect(await executeProposal(p.id, { actor: actor.label })).toMatchObject({ status: 'blocked', reason: 'no active subscription' })
    } finally {
      setTransportOverride(null)
      delete process.env.BILLING_REQUIRED
      await admin(db => db.query(`update app_subscriptions set status = 'active' where connection_id = $1`, [NW.conn]))
    }
    expect(await writes()).toBe(before)
  })

  it('merchant decisions: acknowledging lasts while the problem persists; exempting a product updates the rule', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const actor = await merchantActor(NW)
    const oversold = (await listIssues(actor)).find(i => i.check_key === 'shopify.oversold_stop_selling')!
    await dismissIssue(actor, oversold.id, 'counting stock tomorrow')
    expect((await runScan(NW.conn, { trigger: 'test' })).issuesOpened).toBe(0)
    await setVariant(V(2010), { available: 4 })
    await runScan(NW.conn, { trigger: 'test' })
    await setVariant(V(2010), { available: -1 })
    expect((await runScan(NW.conn, { trigger: 'test' })).issuesOpened).toBe(1)
    const board = (await listIssues(actor)).find(i => i.resource_id === V(2004))!
    await exemptProduct(actor, board.id)
    const rule = await admin(db => db.one<{ config: { exemptProductIds: string[] }; version: number }>(`select config, version from merchant_rules where connection_id = $1 and check_key = 'shopify.oversell_policy'`, [NW.conn]))
    expect(rule!.config.exemptProductIds).toContain(P(1003))
    expect(rule!.version).toBe(2)
    await runScan(NW.conn, { trigger: 'test' })
    expect((await listIssues(actor)).some(i => i.resource_id === V(2004))).toBe(false)
  })
})
