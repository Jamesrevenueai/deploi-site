/**
 * The live Admin GraphQL path of the commerce pack against a fake GraphQL layer: it checks each operation's name,
 * the fields its query asks for and its variables, answers from a small in-memory store, and can answer THROTTLED,
 * userErrors or HTTP 401. Requests go through the real client (shopifyGraphql) with the transport overridden, so
 * throttling, retries and error mapping are the production ones. Built, fake-tested, not live-verified.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { NW, resetLibrary } from '../library/helpers'
import { runCommerceAgent, setCommerceStoreOverride } from '../../lib/commerce/pack'
import { admin } from '../../lib/db'
import { loadConnection } from '../../lib/engine/scan'
import { setTransportOverride, setSleep, resetThrottleState, type Transport, type GqlBody } from '../../lib/connectors/shopify/client'
import { liveCommerceStoreFor, LIVE_STATUS, Q } from '../../lib/commerce/pack/live-store'
import { CommerceError, type CommerceStore } from '../../lib/commerce/pack/store'
import { COMMERCE_PACK_SCOPES, ALL_COMMERCE_PACK_SCOPES, PROTECTED_CUSTOMER_DATA } from '../../lib/commerce/pack/scopes'
import type { ConnectionRow } from '../../lib/engine/types'

const ready = await prepareDb()

/** fields each operation's query must ask for: a change that drops one fails here */
const SHAPES: Record<string, string[]> = {
  DeploiPackShop: ['shop', 'name', 'currencyCode'],
  DeploiPackProducts: ['products(first: $first, after: $after', 'pageInfo', 'descriptionHtml', 'seo', 'vendor', 'productType', 'media(first: 20)', 'alt', 'inventoryPolicy', 'inventoryQuantity', 'tracked', 'barcode'],
  DeploiPackOrders: ['orders(first: $first, after: $after, query: $query', 'displayFulfillmentStatus', 'lineItems', 'trackingInfo', 'deliveredAt', 'events(first: 1, sortKey: HAPPENED_AT, reverse: true)', 'customer { firstName }', 'email'],
  DeploiPackReturns: ['return_status:return_requested', 'returns(first: 10)', 'returnLineItems', 'returnReason', 'fulfillmentLineItem'],
  DeploiPackRefunds: ['order(id: $id)', 'refunds', 'totalRefundedSet'],
  DeploiPackCollections: ['collections(first: $first', 'ruleSet', 'products(first: 250)'],
  DeploiPackDiscounts: ['codeDiscountNodes', 'DiscountCodeBasic', 'status', 'endsAt', 'codes(first: 1)', 'DiscountPercentage'],
  DeploiPackPayouts: ['shopifyPaymentsAccount', 'payouts', 'chargesGross', 'chargesFee', 'net'],
  DeploiPackPayoutOrders: ['balanceTransactions', 'associatedOrder'],
  DeploiPackProductText: ['product(id: $id)', 'descriptionHtml', 'seo'],
  DeploiPackProductUpdate: ['mutation', 'productUpdate(product: $product)', 'userErrors'],
  DeploiPackVariant: ['productVariant(id: $id)', 'inventoryPolicy', 'product { id }'],
  DeploiPackSetInventoryPolicy: ['mutation', 'productVariantsBulkUpdate', 'userErrors'],
  DeploiPackCollectionHas: ['collection(id: $id)', 'hasProduct(id: $productId)'],
  DeploiPackCollectionRemove: ['mutation', 'collectionRemoveProducts', 'userErrors'],
  DeploiPackCollectionAdd: ['mutation', 'collectionAddProducts', 'userErrors'],
  DeploiPackDiscountStatus: ['codeDiscountNode(id: $id)', 'status'],
  DeploiPackDiscountDeactivate: ['mutation', 'discountCodeDeactivate(id: $id)', 'userErrors'],
  DeploiPackDiscountActivate: ['mutation', 'discountCodeActivate(id: $id)', 'userErrors'],
  DeploiPackReturnStatus: ['return(id: $id)', 'status'],
  DeploiPackReturnApprove: ['mutation', 'returnApproveRequest(input: $input)', 'userErrors'],
  DeploiPackReturnDecline: ['mutation', 'returnDeclineRequest(input: $input)', 'userErrors'],
  DeploiPackSuggestedRefund: ['suggestedRefund(refundLineItems: $refundLineItems)', 'suggestedTransactions', 'parentTransaction'],
  DeploiPackRefund: ['mutation', 'refundCreate(input: $input)', 'userErrors'],
}
const COST = { cost: { requestedQueryCost: 10, actualQueryCost: 10, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 } } }
const money = (amount: string) => ({ shopMoney: { amount } })

type Fake = { calls: GqlBody[]; refuse: Set<string>; throttleOnce: Set<string>; status401: boolean; db: ReturnType<typeof model> }
function model() {
  return {
    description: '<p>Mug.</p>', seo: null as string | null, policy: 'CONTINUE', inFeatured: true, discount: 'ACTIVE', returnStatus: 'REQUESTED', refunds: [] as { id: string; amount: string }[],
  }
}
function fakeShopify(): Fake & { transport: Transport } {
  const f: Fake = { calls: [], refuse: new Set(), throttleOnce: new Set(), status401: false, db: model() }
  const userErrors = (op: string) => (f.refuse.has(op) ? [{ field: ['id'], message: `${op} refused (fake)`, code: 'INVALID' }] : [])
  const transport: Transport = async body => {
    f.calls.push(body)
    if (f.status401) return { status: 401, json: null }
    const shape = SHAPES[body.operationName]
    if (!shape) return { status: 200, json: { errors: [{ message: `unknown operation ${body.operationName}` }] } }
    expect(body.query).toContain(body.operationName)
    for (const s of shape) expect(body.query, `${body.operationName} asks for ${s}`).toContain(s)
    if (f.throttleOnce.delete(body.operationName)) return { status: 200, json: { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: COST } }
    const v = body.variables ?? {}
    const d = f.db
    const page = <T>(nodes: T[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes })
    const ok = (data: unknown) => ({ status: 200, json: { data, extensions: COST } })
    switch (body.operationName) {
      case 'DeploiPackShop': return ok({ shop: { name: 'Fake Shop', currencyCode: 'USD' } })
      case 'DeploiPackProducts': {
        expect(v.first).toBe(50)
        return ok({ products: page([{ id: 'gid://shopify/Product/1', title: 'Mug', handle: 'mug', status: 'ACTIVE', tags: [], vendor: 'Clay & Kiln', productType: 'Mugs', descriptionHtml: d.description, seo: { description: d.seo }, material: { value: 'Stoneware' }, care: null, dimensions: null, media: { nodes: [{ alt: null }] }, variants: { nodes: [{ id: 'gid://shopify/ProductVariant/11', title: 'Default Title', sku: 'M-1', barcode: null, price: '24.00', inventoryPolicy: d.policy, inventoryQuantity: 0, inventoryItem: { tracked: true } }] } }]) })
      }
      case 'DeploiPackOrders':
        expect(String(v.query)).toMatch(/^created_at:>=\d{4}-\d{2}-\d{2}$/)
        return ok({ orders: page([{ id: 'gid://shopify/Order/5', name: '#1005', createdAt: '2026-11-01T10:00:00Z', cancelledAt: null, email: 'a@shopper.example', displayFulfillmentStatus: 'FULFILLED', customer: { firstName: 'Ann' }, totalPriceSet: money('24.00'), lineItems: { nodes: [{ id: 'gid://shopify/LineItem/51', title: 'Mug', quantity: 1, product: { id: 'gid://shopify/Product/1' }, variant: { id: 'gid://shopify/ProductVariant/11' }, originalUnitPriceSet: money('24.00') }] }, fulfillments: [{ createdAt: '2026-11-02T10:00:00Z', deliveredAt: null, trackingInfo: [{ number: 'TRK1', url: 'https://t.example/TRK1', company: 'UPS' }], events: { nodes: [{ status: 'IN_TRANSIT', happenedAt: '2026-11-03T10:00:00Z' }] } }] }]) })
      case 'DeploiPackReturns':
        return ok({ orders: page([{ id: 'gid://shopify/Order/5', name: '#1005', email: 'a@shopper.example', customer: { firstName: 'Ann' }, fulfillments: [{ deliveredAt: '2026-11-03T10:00:00Z' }], returns: { nodes: [{ id: 'gid://shopify/Return/9', status: d.returnStatus, returnLineItems: { nodes: [{ id: 'gid://shopify/ReturnLineItem/91', quantity: 1, returnReason: 'DEFECTIVE', returnReasonNote: 'cracked', customerNote: null, fulfillmentLineItem: { lineItem: { id: 'gid://shopify/LineItem/51', title: 'Mug', originalUnitPriceSet: money('24.00') } } }] } }] } }]) })
      case 'DeploiPackRefunds': return ok({ order: { id: v.id, refunds: d.refunds.map(r => ({ id: r.id, createdAt: '2026-11-05T00:00:00Z', totalRefundedSet: money(r.amount) })) } })
      case 'DeploiPackCollections': return ok({ collections: page([{ id: 'gid://shopify/Collection/1', title: 'Featured', handle: 'featured', ruleSet: null, products: { nodes: d.inFeatured ? [{ id: 'gid://shopify/Product/1' }] : [] } }, { id: 'gid://shopify/Collection/2', title: 'All', handle: 'all', ruleSet: { appliedDisjunctively: false }, products: { nodes: [] } }]) })
      case 'DeploiPackDiscounts': return ok({ codeDiscountNodes: page([{ id: 'gid://shopify/DiscountCodeNode/1', codeDiscount: { __typename: 'DiscountCodeBasic', title: 'Summer', status: d.discount, startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-09-01T00:00:00Z', codes: { nodes: [{ code: 'SUMMER20' }] }, customerGets: { value: { __typename: 'DiscountPercentage', percentage: 0.2 }, items: { __typename: 'AllDiscountItems' } } } }, { id: 'gid://shopify/DiscountAutomaticNode/2', codeDiscount: { __typename: 'DiscountCodeBxgy' } }]) })
      case 'DeploiPackPayouts': return ok({ shopifyPaymentsAccount: { payouts: { nodes: [{ id: 'gid://shopify/ShopifyPaymentsPayout/77', issuedAt: '2026-11-04T00:00:00Z', status: 'PAID', net: { amount: '90.00' }, summary: { chargesGross: { amount: '100.00' }, chargesFee: { amount: '-10.00' }, refundsFeeGross: { amount: '0.00' }, refundsFee: { amount: '0.00' }, adjustmentsGross: { amount: '0.00' }, adjustmentsFee: { amount: '0.00' } } }] } } })
      case 'DeploiPackPayoutOrders':
        expect(v.query).toBe('payout_id:77')
        return ok({ shopifyPaymentsAccount: { balanceTransactions: { nodes: [{ type: 'CHARGE', associatedOrder: { id: 'gid://shopify/Order/5' } }, { type: 'CHARGE', associatedOrder: { id: 'gid://shopify/Order/5' } }, { type: 'ADJUSTMENT', associatedOrder: null }] } } })
      case 'DeploiPackProductText': return ok({ product: v.id === 'gid://shopify/Product/1' ? { id: v.id, descriptionHtml: d.description, seo: { description: d.seo } } : null })
      case 'DeploiPackProductUpdate': {
        const p = v.product as { id: string; descriptionHtml?: string; seo?: { description: string } }
        expect(p.id).toMatch(/^gid:\/\/shopify\/Product\//)
        const errs = userErrors('DeploiPackProductUpdate')
        if (!errs.length) { if (p.descriptionHtml !== undefined) d.description = p.descriptionHtml; if (p.seo) d.seo = p.seo.description }
        return ok({ productUpdate: { product: errs.length ? null : { id: p.id, descriptionHtml: d.description, seo: { description: d.seo } }, userErrors: errs } })
      }
      case 'DeploiPackVariant': return ok({ productVariant: { id: v.id, inventoryPolicy: d.policy, product: { id: 'gid://shopify/Product/1' } } })
      case 'DeploiPackSetInventoryPolicy': {
        expect(v.productId).toBe('gid://shopify/Product/1')
        expect(v.variants).toEqual([{ id: 'gid://shopify/ProductVariant/11', inventoryPolicy: 'DENY' }])
        const errs = userErrors('DeploiPackSetInventoryPolicy')
        if (!errs.length) d.policy = 'DENY'
        return ok({ productVariantsBulkUpdate: { productVariants: [], userErrors: errs } })
      }
      case 'DeploiPackCollectionHas': return ok({ collection: { id: v.id, ruleSet: v.id === 'gid://shopify/Collection/2' ? { appliedDisjunctively: false } : null, hasProduct: v.id === 'gid://shopify/Collection/1' ? d.inFeatured : false } })
      case 'DeploiPackCollectionRemove': { expect(v.productIds).toEqual(['gid://shopify/Product/1']); const e = userErrors('DeploiPackCollectionRemove'); if (!e.length) d.inFeatured = false; return ok({ collectionRemoveProducts: { job: { id: 'gid://shopify/Job/1', done: false }, userErrors: e } }) }
      case 'DeploiPackCollectionAdd': { const e = userErrors('DeploiPackCollectionAdd'); if (!e.length) d.inFeatured = true; return ok({ collectionAddProducts: { collection: { id: v.id }, userErrors: e } }) }
      case 'DeploiPackDiscountStatus': return ok({ codeDiscountNode: { id: v.id, codeDiscount: { __typename: 'DiscountCodeBasic', status: d.discount } } })
      case 'DeploiPackDiscountDeactivate': { const e = userErrors(body.operationName); if (!e.length) d.discount = 'EXPIRED'; return ok({ discountCodeDeactivate: { codeDiscountNode: { id: v.id, codeDiscount: { __typename: 'DiscountCodeBasic', status: d.discount } }, userErrors: e } }) }
      case 'DeploiPackDiscountActivate': { const e = userErrors(body.operationName); if (!e.length) d.discount = 'ACTIVE'; return ok({ discountCodeActivate: { codeDiscountNode: { id: v.id, codeDiscount: { __typename: 'DiscountCodeBasic', status: d.discount } }, userErrors: e } }) }
      case 'DeploiPackReturnStatus': return ok({ return: { id: v.id, status: d.returnStatus } })
      case 'DeploiPackReturnApprove': { expect(v.input).toEqual({ id: 'gid://shopify/Return/9' }); const e = userErrors(body.operationName); if (!e.length) d.returnStatus = 'OPEN'; return ok({ returnApproveRequest: { return: { id: 'gid://shopify/Return/9', status: d.returnStatus }, userErrors: e } }) }
      case 'DeploiPackReturnDecline': { expect((v.input as { declineReason: string }).declineReason).toBe('OTHER'); const e = userErrors(body.operationName); if (!e.length) d.returnStatus = 'DECLINED'; return ok({ returnDeclineRequest: { return: { id: 'gid://shopify/Return/9', status: d.returnStatus }, userErrors: e } }) }
      case 'DeploiPackSuggestedRefund':
        expect(v.refundLineItems).toEqual([{ lineItemId: 'gid://shopify/LineItem/51', quantity: 1, restockType: 'NO_RESTOCK' }])
        return ok({ order: { id: v.id, suggestedRefund: { amountSet: money('24.00'), suggestedTransactions: [{ gateway: 'shopify_payments', kind: 'SUGGESTED_REFUND', amountSet: money('24.00'), parentTransaction: { id: 'gid://shopify/OrderTransaction/3' } }] } } })
      case 'DeploiPackRefund': {
        const input = v.input as { orderId: string; transactions: { parentId: string; amount: string; kind: string }[]; notify: boolean }
        expect(input.transactions).toEqual([{ orderId: 'gid://shopify/Order/5', gateway: 'shopify_payments', kind: 'REFUND', amount: '24.00', parentId: 'gid://shopify/OrderTransaction/3' }])
        expect(input.notify).toBe(true)
        const e = userErrors(body.operationName)
        if (!e.length) d.refunds.push({ id: 'gid://shopify/Refund/1', amount: '24.00' })
        return ok({ refundCreate: { refund: e.length ? null : { id: 'gid://shopify/Refund/1', totalRefundedSet: money('24.00') }, userErrors: e } })
      }
    }
    return { status: 200, json: { errors: [{ message: 'not handled' }] } }
  }
  return Object.assign(f, { transport })
}

describe.skipIf(!ready)('commerce pack live path (fake Admin GraphQL)', () => {
  let conn: ConnectionRow
  let fake: ReturnType<typeof fakeShopify>
  let store: CommerceStore
  beforeAll(async () => { conn = (await admin(db => loadConnection(db, NW.conn)))! })
  const setup = () => { fake = fakeShopify(); setSleep(async () => {}); setTransportOverride(() => fake.transport); store = liveCommerceStoreFor(conn) }
  afterEach(() => { setTransportOverride(null); setSleep(null); resetThrottleState() })

  it('reads products, orders, returns, collections, discounts and payouts in the shapes the agents use', async () => {
    setup()
    expect(await store.shop()).toEqual({ name: 'Fake Shop', currency: 'USD' })
    const [p] = await store.products()
    expect(p).toMatchObject({ vendor: 'Clay & Kiln', material: 'Stoneware', description: 'Mug.', imageCount: 1, imagesMissingAlt: 1 })
    expect(p.variants[0]).toMatchObject({ available: 0, tracked: true, inventoryPolicy: 'CONTINUE', barcode: null })
    const [o] = await store.orders()
    expect(o).toMatchObject({ name: '#1005', fulfillmentStatus: 'fulfilled', customerFirstName: 'Ann', total: '24.00' })
    expect(o.tracking).toMatchObject({ number: 'TRK1', carrier: 'UPS', lastEvent: 'in transit', deliveredAt: null })
    const [r] = await store.returns()
    expect(r).toMatchObject({ id: 'gid://shopify/Return/9', status: 'requested', amount: '24.00', reason: 'DEFECTIVE', lineItemId: 'gid://shopify/LineItem/51' })
    const cols = await store.collections()
    expect(cols.map(c => [c.handle, c.promoted, c.smart])).toEqual([['featured', true, false], ['all', false, true]])
    const ds = await store.discounts()
    expect(ds).toEqual([expect.objectContaining({ code: 'SUMMER20', percent: 20, status: 'active', endsAt: '2026-09-01T00:00:00Z' })])
    const [po] = await store.payouts()
    expect(po).toMatchObject({ gross: '100.00', fees: '10.00', net: '90.00', orderIds: ['gid://shopify/Order/5'], status: 'paid' })
  })

  it('writes and confirms each change with a fresh read: description, search description, inventory policy, collection, discount, return, refund', async () => {
    setup()
    expect(await store.setDescription('gid://shopify/Product/1', '<p>New.</p>')).toEqual({ before: '<p>Mug.</p>', after: '<p>New.</p>' })
    expect(await store.setSeoDescription('gid://shopify/Product/1', 'Search text')).toEqual({ before: '', after: 'Search text' })
    expect(await store.setInventoryPolicy('gid://shopify/ProductVariant/11', 'DENY')).toEqual({ before: 'CONTINUE', after: 'DENY' })
    expect(await store.removeFromCollection('gid://shopify/Collection/1', 'gid://shopify/Product/1')).toEqual({ before: 'in collection', after: 'not in collection' })
    expect(await store.addToCollection('gid://shopify/Collection/1', 'gid://shopify/Product/1')).toEqual({ before: 'not in collection', after: 'in collection' })
    await expect(store.removeFromCollection('gid://shopify/Collection/2', 'gid://shopify/Product/1')).rejects.toMatchObject({ code: 'refused' })
    expect(await store.deactivateDiscount('gid://shopify/DiscountCodeNode/1')).toEqual({ before: 'active', after: 'expired' })
    expect(await store.activateDiscount('gid://shopify/DiscountCodeNode/1')).toEqual({ before: 'expired', after: 'active' })
    expect(await store.approveReturn('gid://shopify/Return/9')).toEqual({ before: 'requested', after: 'open' })
    expect(await store.refund({ orderId: 'gid://shopify/Order/5', lineItemId: 'gid://shopify/LineItem/51', quantity: 1, amount: '24.00', note: 'damaged' })).toEqual({ id: 'gid://shopify/Refund/1', amount: '24.00' })
    expect(await store.refunds('gid://shopify/Order/5')).toEqual([expect.objectContaining({ id: 'gid://shopify/Refund/1', amount: '24.00' })])
    // mutations are sent once each (never retried)
    const ops = fake.calls.map(c => c.operationName)
    expect(ops.filter(x => x === 'DeploiPackRefund')).toHaveLength(1)
  })

  it('never refunds more than Shopify suggests for the items', async () => {
    setup()
    await expect(store.refund({ orderId: 'gid://shopify/Order/5', lineItemId: 'gid://shopify/LineItem/51', quantity: 1, amount: '30.00', note: 'x' })).rejects.toMatchObject({ code: 'refused' })
    expect(fake.calls.map(c => c.operationName)).not.toContain('DeploiPackRefund')
  })

  it('a userError is a refusal: nothing changes and the error names the mutation', async () => {
    setup()
    fake.refuse.add('DeploiPackProductUpdate')
    const e = await store.setDescription('gid://shopify/Product/1', '<p>x</p>').catch(x => x)
    expect(e).toBeInstanceOf(CommerceError)
    expect(e).toMatchObject({ code: 'refused' })
    expect(e.message).toMatch(/productUpdate: DeploiPackProductUpdate refused/)
    expect(fake.db.description).toBe('<p>Mug.</p>')
    fake.refuse.add('DeploiPackDiscountDeactivate')
    await expect(store.deactivateDiscount('gid://shopify/DiscountCodeNode/1')).rejects.toMatchObject({ code: 'refused' })
  })

  it('throttling: a THROTTLED read and a THROTTLED mutation are waited out and retried by the client', async () => {
    setup()
    fake.throttleOnce.add('DeploiPackProducts')
    fake.throttleOnce.add('DeploiPackDiscountDeactivate')
    expect(await store.products()).toHaveLength(1)
    expect((await store.deactivateDiscount('gid://shopify/DiscountCodeNode/1')).after).toBe('expired')
    expect(fake.calls.filter(c => c.operationName === 'DeploiPackProducts')).toHaveLength(2)
    expect(fake.calls.filter(c => c.operationName === 'DeploiPackDiscountDeactivate')).toHaveLength(2)
  })

  it('HTTP 401 (app uninstalled or token revoked) maps to uninstalled', async () => {
    setup()
    fake.status401 = true
    await expect(store.products()).rejects.toMatchObject({ code: 'uninstalled' })
  })

  it('what is not reachable through the Admin API refuses with not_wired, and the status table says so', async () => {
    setup()
    await expect(store.announcement()).rejects.toMatchObject({ code: 'not_wired' })
    await expect(store.setAnnouncement(null)).rejects.toMatchObject({ code: 'not_wired' })
    await expect(store.sendEmail({ to: 'a@b.example', subject: 's', text: 't', inReplyTo: null, agentKey: 'customer_care' })).rejects.toMatchObject({ code: 'not_wired' })
    expect(Object.entries(LIVE_STATUS).filter(([, s]) => s === 'not_wired').map(([k]) => k).sort()).toEqual(['announcement', 'inbox', 'sendEmail', 'sent', 'setAnnouncement'])
    // every query document has an operation the fake checks
    for (const doc of Object.values(Q)) expect(Object.keys(SHAPES)).toContain(/(?:query|mutation)\s+(\w+)/.exec(doc)![1])
  })

  it('end to end on the live path: Listing Writer and Inventory Watcher act through Admin GraphQL and verify with a fresh read; Customer Care fails honestly without a mail path', async () => {
    setup()
    await resetLibrary(NW)
    setCommerceStoreOverride(async () => store)
    try {
      const e = { source: 'sweep' as const, type: 'sweep', orgId: NW.org, externalId: 'sweep:live', occurredAt: new Date().toISOString(), payload: {} }
      const lw = await runCommerceAgent('listing_writer', e)
      expect(lw.outcomes.map(o => [o.kind, o.status])).toEqual([['weak_description', 'done']])
      expect(fake.db.description).toBe('<p>The Mug from Clay &amp; Kiln is part of our mugs range.</p><p>Made from stoneware.</p>')
      const iw = await runCommerceAgent('inventory_watcher', e)
      expect(iw.outcomes.map(o => [o.kind, o.status])).toEqual([['selling_past_zero', 'done']])
      expect(fake.db.policy).toBe('DENY')
      const mail = { source: 'outlook' as const, type: 'mail.received', orgId: NW.org, externalId: 'm1', occurredAt: new Date().toISOString(), payload: { id: 'm1', from: 'a@shopper.example', subject: 'Where is my order #1005?', text: 'where is my order' } }
      const cc = await runCommerceAgent('customer_care', mail)
      expect(cc.outcomes.map(o => [o.kind, o.status])).toEqual([['wismo_email', 'failed']])
      expect(cc.outcomes[0].error).toMatch(/^not_wired/)
    } finally { setCommerceStoreOverride(null) }
  })

  it('lists the exact scopes and the protected customer data each agent needs', () => {
    expect(Object.keys(COMMERCE_PACK_SCOPES)).toHaveLength(12)
    expect(ALL_COMMERCE_PACK_SCOPES).toEqual(['read_discounts', 'read_inventory', 'read_orders', 'read_products', 'read_returns', 'read_shopify_payments_payouts', 'write_discounts', 'write_orders', 'write_products', 'write_returns'])
    expect(PROTECTED_CUSTOMER_DATA).toMatchObject({ order_tracker: 'level2', returns: 'level2', customer_care: 'level2', inventory_watcher: 'level1' })
    expect(PROTECTED_CUSTOMER_DATA.listing_writer).toBeUndefined()
  })
})
