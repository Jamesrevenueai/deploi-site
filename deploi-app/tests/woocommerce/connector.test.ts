/**
 * The WooCommerce connector against a synthetic store (real client, real request paths): catalogue reads,
 * fresh targeted reads, SKU lookups, and the connector's own refusals before any write.
 */
import './helpers'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { loadConnection } from '../../lib/engine/scan'
import { getConnector } from '../../lib/engine/registry'
import { wooConnector, parseTarget } from '../../lib/connectors/woocommerce/connector'
import { mutateWooSynthetic, injectWooFault } from '../../lib/connectors/woocommerce/synthetic'
import { wooBackordersCheck, wooLowStockCheck, wooOversoldCheck, type WooStockRecord } from '../../lib/connectors/woocommerce/checks'
import { WOO_PUBLISH, WOO_SET_SKU } from '../../lib/connectors/woocommerce/listing-checks'
import type { ConnectionRow, Correction } from '../../lib/engine/types'
import { WOO, resetWoo, dropWoo, wooStore } from './helpers'

const ready = await prepareDb()
const conn = async () => (await admin(db => loadConnection(db, WOO.conn)))!
const all = async (c: ConnectionRow) => { const out: WooStockRecord[] = []; for await (const p of wooConnector.listResources(c)) out.push(...p); return out }

beforeEach(async () => { if (ready) await resetWoo() })
afterAll(async () => { if (ready) await dropWoo() })

describe('registration', () => {
  it('WooCommerce is operational and registered for the engine', () => {
    expect(getConnector('woocommerce')).toBe(wooConnector)
    expect(wooConnector.operational).toBe(true)
    expect(wooConnector.requiredScopes.actions['woocommerce.product.set_backorders']).toEqual(['write'])
    expect(parseTarget('variation:12:34')).toEqual({ productId: 12, variationId: 34, path: '/products/12/variations/34' })
    expect(parseTarget('product:../../users')).toBeNull()
  })
})

describe.skipIf(!ready)('reads', () => {
  it('lists every product and variation with stock, prices, status and the store-wide setting', async () => {
    const recs = await all(await conn())
    const ids = recs.map(r => r.resourceId)
    expect(ids).toEqual(expect.arrayContaining(['product:101', 'product:110', 'variation:110:111', 'variation:110:112', 'product:120', 'variation:120:121']))
    const s = await wooStore()
    expect(s.requestLog!.some(r => r.path === '/wp-json/wc/v3/products' && r.query.status === 'any' && r.query.per_page === '100')).toBe(true)
    const r101 = recs.find(r => r.resourceId === 'product:101')!
    expect(r101).toMatchObject({ manageStock: true, stockQuantity: 0, backorders: 'notify', stockStatus: 'onbackorder', storeManageStock: true, price: '42.00', productStatus: 'ACTIVE', published: { 'woocommerce:storefront': true } })
    expect(recs.find(r => r.resourceId === 'variation:120:121')).toMatchObject({ manageStock: 'parent', stockQuantity: 0, backorders: 'notify', variantTitle: '3 pack' })
    expect(recs.find(r => r.resourceId === 'product:108')).toMatchObject({ onSale: true, price: '49.00', compareAtPrice: '55.00' })
    // the checks find what the catalogue holds
    const cfg = wooBackordersCheck.parseConfig({})
    expect(recs.filter(r => wooBackordersCheck.detect(r, cfg, { ruleVersion: 1 })).map(r => r.resourceId).sort()).toEqual(['product:101', 'product:120', 'variation:110:111'])
    expect(recs.filter(r => wooOversoldCheck.detect(r, {}, { ruleVersion: 1 })).map(r => r.resourceId)).toEqual(['product:102'])
    expect(recs.filter(r => wooLowStockCheck.detect(r, {}, { ruleVersion: 1 })).map(r => r.resourceId).sort()).toEqual(['product:101', 'product:103', 'product:104', 'product:120', 'variation:110:111'])
  })
  it('fresh targeted reads bypass the REST cache, return a variable product with its variations, and skip missing ids', async () => {
    const m = await wooConnector.readResources(await conn(), ['product:110', 'variation:120:122', 'product:999', 'nonsense'])
    expect([...m.keys()].sort()).toEqual(['product:110', 'product:120', 'variation:110:111', 'variation:110:112', 'variation:120:122'])
    expect((await wooStore()).requestLog!.filter(r => r.path === '/wp-json/wc/v3/products/110').every(r => r.query._skip_cache === '1')).toBe(true)
  })
  it('a store with stock management off store-wide reports it, and the backorders check stands down', async () => {
    await mutateWooSynthetic(WOO.conn, s => { s.settings.manage_stock = 'no' })
    const recs = await all(await conn())
    expect(recs.find(r => r.resourceId === 'product:101')).toMatchObject({ storeManageStock: false, manageStock: false })
    expect(recs.filter(r => wooBackordersCheck.detect(r, wooBackordersCheck.parseConfig({}), { ruleVersion: 1 }))).toEqual([])
  })
  it('finds items by SKU across products and variations', async () => {
    const found = await wooConnector.findResources!(await conn(), { skus: ['nw-ct-l', 'NW-OCB'], barcodes: [], handles: [] })
    expect(found.map(r => r.resourceId).sort()).toEqual(['product:101', 'variation:110:112'])
  })
  it('a read that keeps failing surfaces as an error (the engine never acts on a partial read)', async () => {
    await injectWooFault(WOO.conn, { op: 'GET /products', mode: 'http_500', remaining: 10 })
    await expect(all(await conn())).rejects.toMatchObject({ kind: 'unknown' })
  })
})

describe.skipIf(!ready)('the connector enforces its own limits before writing', () => {
  const corr = (over: Partial<Correction> = {}): Correction => ({ actionKey: 'woocommerce.product.set_backorders', targetType: 'woo_stock_object', targetId: 'product:101', targetLabel: 'x', change: { field: 'backorders', from: 'notify', to: 'no' }, preconditions: [], params: { path: '/products/101' }, ...over })
  it('refuses a field outside allowedFields, unknown actions, mismatched paths and bad values, with no request sent', async () => {
    const c = await conn()
    for (const [x, allowed] of [
      [corr(), ['sku']],
      [corr({ actionKey: 'woocommerce.product.delete' }), undefined],
      [corr({ params: { path: '/products/102' } }), undefined],
      [corr({ targetId: 'product:101/../102' }), undefined],
      [corr({ change: { field: 'backorders', from: 'notify', to: 'sometimes' } }), undefined],
      [corr({ actionKey: WOO_SET_SKU, change: { field: 'sku', from: null, to: '  ' } }), undefined],
      [corr({ actionKey: 'woocommerce.product.set_price', change: { field: 'price', from: '1.00', to: '1.5' }, params: { wooField: 'regular_price' } }), undefined],
      [corr({ actionKey: 'woocommerce.product.set_price', change: { field: 'price', from: '1.00', to: '1.50' }, params: { wooField: 'stock_quantity' } }), undefined],
    ] as [Correction, string[] | undefined][]) {
      const r = await wooConnector.applyAction(c, x, allowed)
      expect(r, JSON.stringify(x)).toMatchObject({ outcome: 'rejected', blocked: true })
    }
    expect((await wooStore()).writeLog).toHaveLength(0)
  })
  it('publish only moves a draft: a private, pending or scheduled product is never touched', async () => {
    const c = await conn()
    const pub = (id: number): Correction => ({ actionKey: WOO_PUBLISH, targetType: 'woo_stock_object', targetId: `product:${id}`, targetLabel: 'x', change: { field: 'published.woocommerce:storefront', from: false, to: true }, preconditions: [] })
    expect(await wooConnector.applyAction(c, pub(107), ['published'])).toMatchObject({ outcome: 'rejected', blocked: true })
    await mutateWooSynthetic(WOO.conn, s => { s.products.find(p => p.id === 106)!.status = 'private' })
    expect(await wooConnector.applyAction(c, pub(106), ['published'])).toMatchObject({ outcome: 'rejected', blocked: true })
    expect((await wooStore()).writeLog).toHaveLength(0)
    await mutateWooSynthetic(WOO.conn, s => { s.products.find(p => p.id === 106)!.status = 'draft' })
    expect(await wooConnector.applyAction(c, pub(106), ['published'])).toMatchObject({ outcome: 'applied', request: { method: 'PUT', path: '/products/106', body: { status: 'publish' } } })
  })
  it('a lost answer is unknown and the request is not repeated; a refusal is a definite failure', async () => {
    const c = await conn()
    await injectWooFault(WOO.conn, { op: 'PUT /products/:id', mode: 'lost_response_applied' })
    expect(await wooConnector.applyAction(c, corr())).toMatchObject({ outcome: 'unknown' })
    expect((await wooStore()).writeLog).toHaveLength(1)
    await injectWooFault(WOO.conn, { op: 'PUT /products/:id', mode: 'reject_400' })
    const r = await wooConnector.applyAction(c, corr({ change: { field: 'backorders', from: 'no', to: 'notify' } }))
    expect(r).toMatchObject({ outcome: 'rejected', response: { code: 'woocommerce_rest_invalid_request', status: 400 } })
    expect(r.blocked).toBeFalsy()
  })
})
