/**
 * Pluggable connectors: a second platform plugs in through the registry alone. This test registers an
 * operational in-memory WooCommerce connector (the real one stays planned) and runs an agent on it end
 * to end: same agent lifecycle, same permission tiers, same execution engine, same audit trail. No agent,
 * policy or audit code knows about WooCommerce. Unknown action keys are refused.
 */
import './env'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { registerConnector, getConnector } from '../../lib/engine/registry'
import { correctionCapability, correctionTypeForAction, fieldForAction, supportedCorrections } from '../../lib/engine/capabilities'
import type { Connector, ConnectionRow, Correction } from '../../lib/engine/types'
import { WOO_BACKORDERS_CHECK, wooResourceId, type WooStockRecord } from '../../lib/connectors/woocommerce/checks'
import { createAgent, grantPolicy } from '../../lib/agents/lifecycle'
import { runAgent } from '../../lib/agents/run'
import { agentWorkLog } from '../../lib/agents/worklog'
import { NW, merchantActor } from './helpers'

const ready = await prepareDb()
const WOO_CONN = uuidFrom('connection:northwind-woo-test')

// ---- an in-memory WooCommerce store and connector (what a real connector module would provide)
const rec = (productId: number, over: Partial<WooStockRecord> = {}): WooStockRecord => ({
  resourceType: 'woo_stock_object', resourceId: wooResourceId(productId, null), fetchedAt: new Date().toISOString(),
  productId, variationId: null, name: `Woo product ${productId}`, sku: `W-${productId}`, type: 'simple', status: 'publish', tags: [],
  manageStock: true, stockQuantity: 0, stockStatus: 'onbackorder', backorders: 'notify', storeManageStock: true, dateModifiedGmt: null, ...over,
})
let wooStore = new Map<string, WooStockRecord>()
const writesSeen: Correction[] = []
const planned = getConnector('woocommerce')
const wooConnector: Connector<WooStockRecord> = {
  platform: 'woocommerce', operational: true,
  requiredScopes: { read: ['read'], actions: { 'woocommerce.product.set_backorders': ['write'] } },
  async *listResources() { yield [...wooStore.values()].map(r => ({ ...r, fetchedAt: new Date().toISOString() })) },
  async readResources(_c: ConnectionRow, ids: string[]) { return new Map(ids.filter(i => wooStore.has(i)).map(i => [i, { ...wooStore.get(i)!, fetchedAt: new Date().toISOString() }])) },
  async applyAction(_c: ConnectionRow, corr: Correction, allowed?: string[]) {
    if (allowed && !allowed.includes(corr.change.field)) return { outcome: 'rejected', request: {}, response: null, error: 'field not allowed', blocked: true }
    writesSeen.push(corr)
    const r = wooStore.get(corr.targetId)!
    wooStore.set(corr.targetId, { ...r, backorders: String(corr.change.to), stockStatus: 'outofstock' })
    return { outcome: 'applied', request: { id: corr.targetId, backorders: corr.change.to }, response: { ok: true } }
  },
}

beforeAll(async () => {
  registerConnector(wooConnector as unknown as Connector)
  if (!ready) return
  await admin(db => db.query(`insert into store_connections (id, org_id, platform, external_id, display_name, status, scopes, is_synthetic, currency)
    values ($1,$2,'woocommerce','woo-test.example','Northwind Woo (test)','active',$3,true,'USD') on conflict (id) do update set status = 'active'`, [WOO_CONN, NW.org, ['read', 'write']]))
})
afterAll(async () => {
  registerConnector(planned) // the real WooCommerce connector stays planned
  if (ready) await admin(async db => {
    await db.query('delete from agent_runs where agent_id in (select id from agents where connection_id = $1)', [WOO_CONN])
    await db.query('delete from executions where connection_id = $1', [WOO_CONN])
    await db.query('delete from approvals where proposal_id in (select id from proposals where connection_id = $1)', [WOO_CONN])
    await db.query('delete from proposals where connection_id = $1', [WOO_CONN])
    await db.query('delete from issues where connection_id = $1', [WOO_CONN])
    await db.query('delete from scans where connection_id = $1', [WOO_CONN])
    await db.query('update agents set active_policy_id = null where connection_id = $1', [WOO_CONN])
    await db.query('delete from agents where connection_id = $1', [WOO_CONN])
    await db.query('delete from store_connections where id = $1', [WOO_CONN])
  })
})

describe('connector capabilities (no database)', () => {
  it('each platform declares its corrections; agents and permissions use only the neutral names', () => {
    expect(supportedCorrections('shopify').sort()).toEqual(['oversell_policy', 'price', 'publication', 'sku'])
    expect(correctionCapability('woocommerce', 'oversell_policy')?.checkKey).toBe(WOO_BACKORDERS_CHECK)
    expect(correctionTypeForAction('woocommerce.product.set_backorders')).toBe('oversell_policy')
    expect(fieldForAction('shopify.variant.set_sku')).toBe('sku')
    expect(correctionTypeForAction('woocommerce.product.delete')).toBeUndefined()
    expect(fieldForAction('made.up.action')).toBeUndefined()
  })
  it('the planned connectors still refuse every call', async () => {
    expect(planned.operational).toBe(false)
    await expect(planned.readResources({} as ConnectionRow, ['x'])).rejects.toThrow(/planned/)
  })
})

describe.skipIf(!ready)('a second platform plugs in without agent changes', () => {
  it('drafts only on WooCommerce: the exact change is recorded and nothing is written', async () => {
    wooStore = new Map([[wooResourceId(11, null), rec(11)], [wooResourceId(12, null), rec(12, { tags: ['preorder'] })], [wooResourceId(13, null), rec(13, { stockQuantity: 5, backorders: 'no' })]])
    const actor = await merchantActor(NW)
    const c = await createAgent(actor, { name: 'Woo drafter', taskText: '', policy: { connectionId: WOO_CONN, correctionTypes: ['oversell_policy'], productScope: { mode: 'all' } } })
    await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
    const r = await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    expect(r.status).toBe('completed')
    expect(r.counts).toMatchObject({ drafted: 1, autoApproved: 0 }) // the pre-order product is exempt, the in-stock one is fine
    expect(writesSeen).toHaveLength(0)
  })

  it('authorized without asking on WooCommerce: writes the one declared field, verifies it, and logs it like Shopify', async () => {
    wooStore = new Map([[wooResourceId(21, null), rec(21)], [wooResourceId(22, null), rec(22, { backorders: 'yes' })]])
    const actor = await merchantActor(NW)
    const c = await createAgent(actor, { name: 'Woo guard', taskText: '', policy: { connectionId: WOO_CONN, correctionTypes: ['oversell_policy'], productScope: { mode: 'all' }, approvalMode: 'autonomous', validUntil: new Date(Date.now() + 90 * 864e5).toISOString() } })
    await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
    const r = await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    expect(r.counts).toMatchObject({ autoApproved: 2, verified: 2, failed: 0 })
    expect(writesSeen.map(w => w.change.field)).toEqual(['backorders', 'backorders'])
    expect([...wooStore.values()].every(x => x.backorders === 'no')).toBe(true)
    const log = await agentWorkLog(actor, c.agentId)
    expect(log.filter(e => e.event === 'execution.verified')).toHaveLength(2)
    expect(log.find(e => e.event === 'execution.verified')!.permission).toMatch(/^standing authorization v1/)
  })
})
