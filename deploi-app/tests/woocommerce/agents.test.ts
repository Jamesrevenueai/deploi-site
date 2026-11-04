/**
 * Every WooCommerce correction end to end with an agent, through the same engine as Shopify: a run in
 * review mode leaves exact changes waiting for approval; an authorized (autonomous) run writes one field,
 * verifies it with a fresh read and records it. Also: stale preconditions, lost answers that never turn
 * into duplicate writes, templates (Inventory Watcher, Supplier Chaser) on a WooCommerce store.
 */
import './helpers'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { approveProposal } from '../../lib/engine/approve'
import { executeProposal, retryExecution } from '../../lib/engine/execute'
import type { ProposalRow } from '../../lib/engine/proposals'
import { runAgent } from '../../lib/agents/run'
import { loadAgentContext } from '../../lib/agents/plan'
import { templatePolicy } from '../../lib/agents/templates'
import { reorderCandidates } from '../../lib/email/tasks'
import { runScan } from '../../lib/engine/scan'
import { mutateWooSynthetic, injectWooFault } from '../../lib/connectors/woocommerce/synthetic'
import { WOO_OVERSOLD_CHECK, WOO_BACKORDERS_CHECK } from '../../lib/connectors/woocommerce/checks'
import type { ResourceRecord } from '../../lib/engine/types'
import { merchantActor, NW } from '../merchant/helpers'
import { WOO, UNTIL, resetWoo, dropWoo, wooStore, upload, wooAgent } from './helpers'

const ready = await prepareDb()
const STOCK = { correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: ['preorder', 'pre-order', 'backorder'], flagInStockVariants: true } } }
const proposals = (agentId: string) => admin(db => db.query<ProposalRow>(`select * from proposals where agent_id = $1 order by created_at`, [agentId]))
const proposalFor = async (agentId: string, target: string) => (await proposals(agentId)).filter(p => p.target_id === target).pop()!
const product = async (id: number) => (await wooStore()).products.find(p => p.id === id)!
const variation = async (pid: number, vid: number) => (await product(pid)).variations!.find(v => v.id === vid)!
const writes = async () => (await wooStore()).writeLog.length

beforeEach(async () => { if (ready) await resetWoo() })
afterAll(async () => { if (ready) await dropWoo() })

describe.skipIf(!ready)('overselling (backorders) on WooCommerce', () => {
  it('review mode: exact changes wait for approval; approving one writes backorders=no, verified by a fresh read', async () => {
    const actor = await merchantActor(NW)
    const id = await wooAgent(actor, 'Woo stock review', { ...STOCK, approvalMode: 'review', watch: ['shopify.oversold_stop_selling'] })
    const r = await runAgent(id, { trigger: 'test', actor: actor.label })
    expect(r.status).toBe('completed')
    expect(r.counts).toMatchObject({ proposed: 3, awaitingApproval: 3, autoApproved: 0, needsPerson: 1 })
    expect((await proposals(id)).map(p => p.target_id).sort()).toEqual(['product:101', 'product:120', 'variation:110:111'])
    // the oversold watch named by the template key runs WooCommerce's own check
    const person = await admin(db => db.query<{ check_key: string; resource_id: string }>(`select check_key, resource_id from issues where agent_id = $1 and kind = 'needs_person'`, [id]))
    expect(person).toEqual([{ check_key: WOO_OVERSOLD_CHECK, resource_id: 'product:102' }])
    expect(await writes()).toBe(0)
    const p = await proposalFor(id, 'variation:110:111')
    await approveProposal(actor, p.id, p.change_hash)
    const e = await executeProposal(p.id, { actor: actor.label })
    expect(e.status).toBe('verified')
    expect(await variation(110, 111)).toMatchObject({ backorders: 'no' })
    expect((await wooStore()).writeLog).toMatchObject([{ op: 'PUT /products/:id/variations/:vid', path: '/products/110/variations/111', body: { backorders: 'no' } }])
  })

  it('authorized without asking: every covered change is written once and verified; the pre-order item is exempt', async () => {
    const actor = await merchantActor(NW)
    const id = await wooAgent(actor, 'Woo stock guard', { ...STOCK, approvalMode: 'autonomous', validUntil: UNTIL() })
    const r = await runAgent(id, { trigger: 'test', actor: actor.label })
    expect(r.counts).toMatchObject({ autoApproved: 3, verified: 3, failed: 0 })
    expect(await writes()).toBe(3)
    expect((await product(101)).backorders).toBe('no')
    expect((await product(120)).backorders).toBe('no')
    expect((await product(103)).backorders).toBe('yes')
    const ex = await admin(db => db.query<{ status: string; approver_kind: string }>(`select e.status, a.approver_kind from executions e join approvals a on a.id = e.approval_id where e.agent_id = $1`, [id]))
    expect(ex.every(x => x.status === 'verified' && x.approver_kind === 'standing_authorization')).toBe(true)
    // a second run has nothing left to do and writes nothing
    const again = await runAgent(id, { trigger: 'test', actor: actor.label })
    expect(again.counts).toMatchObject({ proposed: 0, verified: 0 })
    expect(await writes()).toBe(3)
  })

  it('stale: a change made outside Deploi after approval is never overwritten', async () => {
    const actor = await merchantActor(NW)
    const id = await wooAgent(actor, 'Woo stale', { ...STOCK, approvalMode: 'review' })
    await runAgent(id, { trigger: 'test', actor: actor.label })
    const p = await proposalFor(id, 'product:101')
    await approveProposal(actor, p.id, p.change_hash)
    await mutateWooSynthetic(WOO.conn, s => { s.products.find(x => x.id === 101)!.backorders = 'yes' })
    const e = await executeProposal(p.id, { actor: actor.label })
    expect(e).toMatchObject({ status: 'stale', reason: 'records changed since approval' })
    expect(await writes()).toBe(0)
    expect((await product(101)).backorders).toBe('yes')
  })

  it('a lost answer after the write is settled by a fresh read: verified, written exactly once', async () => {
    const actor = await merchantActor(NW)
    const id = await wooAgent(actor, 'Woo lost', { ...STOCK, approvalMode: 'review' })
    await runAgent(id, { trigger: 'test', actor: actor.label })
    const p = await proposalFor(id, 'product:101')
    await approveProposal(actor, p.id, p.change_hash)
    await injectWooFault(WOO.conn, { op: 'PUT /products/:id', mode: 'lost_response_applied' })
    const e = await executeProposal(p.id, { actor: actor.label })
    expect(e.status).toBe('verified')
    expect(await writes()).toBe(1)
    // running the same approval again returns the same execution and never writes again
    expect(await executeProposal(p.id, { actor: actor.label })).toMatchObject({ duplicate: true, status: 'verified' })
    expect(await writes()).toBe(1)
  })

  it('a lost answer before the write is "not applied"; a retry re-checks and writes once', async () => {
    const actor = await merchantActor(NW)
    const id = await wooAgent(actor, 'Woo lost before', { ...STOCK, approvalMode: 'review' })
    await runAgent(id, { trigger: 'test', actor: actor.label })
    const p = await proposalFor(id, 'product:120')
    await approveProposal(actor, p.id, p.change_hash)
    await injectWooFault(WOO.conn, { op: 'PUT /products/:id', mode: 'lost_response_not_applied' })
    const e = await executeProposal(p.id, { actor: actor.label })
    expect(e).toMatchObject({ status: 'failed', reason: 'not applied' })
    expect(await writes()).toBe(0)
    const again = await retryExecution(actor, e.executionId!)
    expect(again.status).toBe('verified')
    expect(await writes()).toBe(1)
  })

  it('a write the store silently ignores (stock management off) is reported, not claimed', async () => {
    const actor = await merchantActor(NW)
    const id = await wooAgent(actor, 'Woo ignored', { ...STOCK, approvalMode: 'review' })
    await runAgent(id, { trigger: 'test', actor: actor.label })
    const p = await proposalFor(id, 'product:101')
    await approveProposal(actor, p.id, p.change_hash)
    await injectWooFault(WOO.conn, { op: 'PUT /products/:id', mode: 'write_ignored' })
    const e = await executeProposal(p.id, { actor: actor.label })
    expect(e.status).toBe('verification_failed')
    expect((await product(101)).backorders).toBe('notify')
  })
})

describe.skipIf(!ready)('prices from a price list', () => {
  const LIST = 'sku,variant_id,price,compare_at_price,currency\nNW-CK,,95.00,,USD\nNW-OCB,,42.00,,USD\n,112,27.00,,USD\nNW-WT,,50.00,,USD\nNW-LA,,99.00,,EUR\n'
  it('review mode drafts exact price changes; sale items are left alone; other currencies go to a person', async () => {
    const actor = await merchantActor(NW)
    const list = await upload(actor, 'price_list', LIST)
    const id = await wooAgent(actor, 'Woo price review', { correctionTypes: ['price'], rules: { price: { sourceId: list, fields: ['price'], maxChangePct: 20 } }, approvalMode: 'review' })
    const r = await runAgent(id, { trigger: 'test', actor: actor.label })
    expect(r.counts).toMatchObject({ proposed: 2, awaitingApproval: 2 })
    const ck = await proposalFor(id, 'product:104')
    expect(ck.change).toMatchObject({ field: 'price', from: '89.00', to: '95.00', params: { wooField: 'regular_price', currency: 'USD' } })
    expect((await proposalFor(id, 'variation:110:112')).change).toMatchObject({ from: '26.00', to: '27.00' })
    const eur = await admin(db => db.one<{ evidence: { summary: string } }>(`select evidence from issues where agent_id = $1 and resource_id = 'product:102'`, [id]))
    expect(eur!.evidence.summary).toMatch(/EUR/)
    await approveProposal(actor, ck.id, ck.change_hash)
    expect((await executeProposal(ck.id, { actor: actor.label })).status).toBe('verified')
    expect((await product(104)).regular_price).toBe('95.00')
    expect((await product(108)).sale_price).toBe('49.00')
  })
  it('authorized: changes within the limit are made and verified; a larger one waits for approval', async () => {
    const actor = await merchantActor(NW)
    const list = await upload(actor, 'price_list', 'sku,variant_id,price,compare_at_price,currency\nNW-CK,,95.00,,USD\n,112,40.00,,USD\n')
    const id = await wooAgent(actor, 'Woo price guard', { correctionTypes: ['price'], rules: { price: { sourceId: list, fields: ['price'], maxChangePct: 20 } }, approvalMode: 'autonomous', validUntil: UNTIL() })
    const r = await runAgent(id, { trigger: 'test', actor: actor.label })
    expect(r.counts).toMatchObject({ autoApproved: 1, verified: 1, awaitingApproval: 1 })
    expect((await product(104)).regular_price).toBe('95.00')
    expect((await variation(110, 112)).regular_price).toBe('26.00')
    expect((await proposalFor(id, 'variation:110:112')).status_reason).toMatch(/exceeds the 20% limit/)
  })
  it('while a sale runs (and sale items are not skipped), the sale price is the one written', async () => {
    const actor = await merchantActor(NW)
    const list = await upload(actor, 'price_list', 'sku,variant_id,price,compare_at_price,currency\nNW-WT,,45.00,55.00,USD\n')
    const id = await wooAgent(actor, 'Woo sale', { correctionTypes: ['price'], rules: { price: { sourceId: list, fields: ['price', 'compareAtPrice'], maxChangePct: 20, skipVariantsOnSale: false } }, approvalMode: 'autonomous', validUntil: UNTIL() })
    const r = await runAgent(id, { trigger: 'test', actor: actor.label })
    expect(r.counts).toMatchObject({ verified: 1 })
    expect(await product(108)).toMatchObject({ sale_price: '45.00', regular_price: '55.00' })
  })
})

describe.skipIf(!ready)('SKUs from a mapping', () => {
  it('fills a missing SKU (authorized), never creates a duplicate, and does not overwrite without permission', async () => {
    const actor = await merchantActor(NW)
    const map = await upload(actor, 'sku_mapping', 'variant_id,barcode,product_handle,variant_title,sku\n105,,,,NW-WOOL\n104,,,,NW-OCB\n,,canvas-tote,Large,NW-CT-LG\n')
    const id = await wooAgent(actor, 'Woo SKU filler', { correctionTypes: ['sku'], rules: { sku: { sourceId: map, allowOverwrite: false } }, approvalMode: 'autonomous', validUntil: UNTIL() })
    const r = await runAgent(id, { trigger: 'test', actor: actor.label })
    expect(r.counts).toMatchObject({ verified: 1 })
    expect((await product(105)).sku).toBe('NW-WOOL')
    const people = await admin(db => db.query<{ resource_id: string; evidence: { summary: string } }>(`select resource_id, evidence from issues where agent_id = $1 and kind = 'needs_person' order by resource_id`, [id]))
    expect(people.map(p => [p.resource_id, p.evidence.summary])).toEqual([
      ['product:104', expect.stringMatching(/already used by another item/)],
      ['variation:110:112', expect.stringMatching(/may only fill missing SKUs/)],
    ])
  })
  it('review mode with overwrite allowed: the approved SKU is written; a change made meanwhile makes it stale', async () => {
    const actor = await merchantActor(NW)
    const map = await upload(actor, 'sku_mapping', 'variant_id,barcode,product_handle,variant_title,sku\n,,canvas-tote,Large,NW-CT-LG\n,,canvas-tote,Small,NW-CT-SM\n')
    const id = await wooAgent(actor, 'Woo SKU review', { correctionTypes: ['sku'], rules: { sku: { sourceId: map, allowOverwrite: true } }, approvalMode: 'review' })
    await runAgent(id, { trigger: 'test', actor: actor.label })
    const large = await proposalFor(id, 'variation:110:112')
    await approveProposal(actor, large.id, large.change_hash)
    expect((await executeProposal(large.id, { actor: actor.label })).status).toBe('verified')
    expect((await variation(110, 112)).sku).toBe('NW-CT-LG')
    const small = await proposalFor(id, 'variation:110:111')
    await approveProposal(actor, small.id, small.change_hash)
    await mutateWooSynthetic(WOO.conn, s => { s.products.find(x => x.id === 110)!.variations!.find(v => v.id === 111)!.sku = 'NW-CT-SMALL' })
    expect((await executeProposal(small.id, { actor: actor.label })).status).toBe('stale')
    expect((await variation(110, 111)).sku).toBe('NW-CT-SMALL')
  })
})

describe.skipIf(!ready)('publication (draft <-> published)', () => {
  const LIST = 'product_id,product_handle,published\n,stoneware-mug,yes\n,holiday-candle,yes\n,oak-cutting-board,no\n'
  it('review mode: publishing a draft waits for approval and is verified; scheduled products and unpublishing without permission go to a person', async () => {
    const actor = await merchantActor(NW)
    const list = await upload(actor, 'publication_list', LIST)
    const id = await wooAgent(actor, 'Woo publisher', { correctionTypes: ['publication'], rules: { publication: { publicationId: 'woocommerce:storefront', publicationName: 'Storefront', sourceId: list, allowUnpublish: false } }, approvalMode: 'review' })
    const r = await runAgent(id, { trigger: 'test', actor: actor.label })
    expect(r.counts).toMatchObject({ proposed: 1, awaitingApproval: 1, needsPerson: 2 })
    const p = await proposalFor(id, 'product:106')
    expect(p.action_key).toBe('woocommerce.product.publish')
    await approveProposal(actor, p.id, p.change_hash)
    expect((await executeProposal(p.id, { actor: actor.label })).status).toBe('verified')
    expect((await product(106)).status).toBe('publish')
    expect((await product(107)).status).toBe('future')
    expect((await product(101)).status).toBe('publish')
  })
  it('authorized with unpublish allowed: moves a published product to draft, verified', async () => {
    const actor = await merchantActor(NW)
    const list = await upload(actor, 'publication_list', 'product_id,product_handle,published\n101,,no\n')
    const id = await wooAgent(actor, 'Woo unpublisher', { correctionTypes: ['publication'], rules: { publication: { publicationId: 'woocommerce:storefront', publicationName: 'Storefront', sourceId: list, allowUnpublish: true } }, approvalMode: 'autonomous', validUntil: UNTIL() })
    const r = await runAgent(id, { trigger: 'test', actor: actor.label })
    expect(r.counts).toMatchObject({ verified: 1 })
    expect((await product(101)).status).toBe('draft')
  })
})

describe.skipIf(!ready)('templates on a WooCommerce store', () => {
  it('Inventory Watcher and Store Health Checker policies resolve to WooCommerce checks', async () => {
    const actor = await merchantActor(NW)
    const policy = templatePolicy('inventory_watcher', { connectionId: WOO.conn, timezone: 'UTC' })
    delete (policy as { email?: unknown }).email
    const id = await wooAgent(actor, 'Woo inventory watcher', policy)
    const ctx = await admin(db => loadAgentContext(db, id))
    expect(ctx!.plan.checks.map(c => c.check.key).sort()).toEqual([WOO_BACKORDERS_CHECK, WOO_OVERSOLD_CHECK].sort())
    const r = await runAgent(id, { trigger: 'test', actor: actor.label })
    expect(r.counts).toMatchObject({ drafted: 3, needsPerson: 1 })
    expect(await writes()).toBe(0)
  })
  it('Supplier Chaser low-stock candidates come from WooCommerce stock-owning items only', async () => {
    let records: ResourceRecord[] = []
    await runScan(WOO.conn, { trigger: 'test', onRecords: r => { records = r } })
    const items = reorderCandidates(records, 2, () => true)
    expect(items.map(i => i.variantId).sort()).toEqual(['product:101', 'product:102', 'product:103', 'product:104', 'product:120', 'variation:110:111'])
    expect(items.find(i => i.variantId === 'variation:110:111')).toMatchObject({ sku: 'NW-CT-S', available: 0, label: 'Canvas Tote / Small' })
  })
  it('a webhook-style targeted rescan re-reads one product and closes issues fixed outside Deploi', async () => {
    const actor = await merchantActor(NW)
    const id = await wooAgent(actor, 'Woo targeted', { ...STOCK, approvalMode: 'review' })
    await runAgent(id, { trigger: 'test', actor: actor.label })
    await mutateWooSynthetic(WOO.conn, s => { s.products.find(x => x.id === 101)!.backorders = 'no' })
    const ctx = await admin(db => loadAgentContext(db, id))
    const r = await runScan(WOO.conn, { trigger: 'webhook', resourceIds: ['product:101'], plan: ctx!.plan })
    expect(r).toMatchObject({ scope: 'targeted', issuesResolved: 1 })
    expect((await proposalFor(id, 'product:101')).status).toBe('stale')
  })
})
