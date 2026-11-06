/**
 * Live Shopify implementation of the commerce pack's CommerceStore: Admin GraphQL reads and writes.
 * Status of every operation: built, tested against a fake GraphQL layer (tests/commerce/pack-live.test.ts checks
 * the operation names, query shapes, variables, userErrors and throttling), NOT verified against a real store yet.
 *
 * Not reachable through the Admin API, so refused here with not_wired (see LIVE_STATUS):
 *  - the storefront announcement bar (a theme setting; writing it needs theme file access Shopify restricts)
 *  - sending email to customers or suppliers, and reading the store mailbox (these go through the merchant's
 *    connected mailbox, not Shopify; mail arrives as AgentEvents of source 'mailbox' / 'outlook')
 * Mutations are never retried except on THROTTLED (the client guarantees that); a userError is a refusal.
 */
import { shopifyGraphql, ShopifyApiError, type GqlBody } from '../../connectors/shopify/client'
import type { ConnectionRow } from '../../engine/types'
import { CommerceError, plainText, type CommerceStore, type CDiscount, type CPayout, type CReturn, type Change } from './store'

export type Gql = <T>(body: GqlBody, opts?: { mutation?: boolean }) => Promise<T>
type Money = { shopMoney: { amount: string } }
type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] }
type UserErrors = { userErrors: { field: string[] | null; message: string; code?: string | null }[] }

/** How far each operation has got. Nothing is live-verified in this build. */
export const LIVE_STATUS: Record<string, 'built_fake_tested' | 'not_wired'> = {
  shop: 'built_fake_tested', products: 'built_fake_tested', orders: 'built_fake_tested', returns: 'built_fake_tested', refunds: 'built_fake_tested',
  collections: 'built_fake_tested', discounts: 'built_fake_tested', payouts: 'built_fake_tested',
  setDescription: 'built_fake_tested', setSeoDescription: 'built_fake_tested', setInventoryPolicy: 'built_fake_tested', removeFromCollection: 'built_fake_tested',
  addToCollection: 'built_fake_tested', deactivateDiscount: 'built_fake_tested', activateDiscount: 'built_fake_tested', approveReturn: 'built_fake_tested',
  declineReturn: 'built_fake_tested', refund: 'built_fake_tested',
  announcement: 'not_wired', setAnnouncement: 'not_wired', inbox: 'not_wired', sent: 'not_wired', sendEmail: 'not_wired',
}

/** Collections that count as "promoted" on a live store, by handle (the merchant can add more in agent settings). */
export const PROMOTED_HANDLES = ['frontpage', 'featured', 'home-page', 'homepage', 'best-sellers', 'bestsellers', 'sale', 'new-arrivals']

export const Q = {
  shop: `query DeploiPackShop { shop { name currencyCode } }`,
  products: `query DeploiPackProducts($first: Int!, $after: String) {
  products(first: $first, after: $after, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle status tags vendor productType descriptionHtml
      seo { description }
      material: metafield(namespace: "custom", key: "material") { value }
      care: metafield(namespace: "custom", key: "care") { value }
      dimensions: metafield(namespace: "custom", key: "dimensions") { value }
      media(first: 20) { nodes { alt } }
      variants(first: 100) { nodes { id title sku barcode price inventoryPolicy inventoryQuantity inventoryItem { tracked } } }
    }
  }
}`,
  orders: `query DeploiPackOrders($first: Int!, $after: String, $query: String!) {
  orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt cancelledAt email displayFulfillmentStatus
      customer { firstName }
      totalPriceSet { shopMoney { amount } }
      lineItems(first: 50) { nodes { id title quantity product { id } variant { id } originalUnitPriceSet { shopMoney { amount } } } }
      fulfillments(first: 10) { createdAt deliveredAt trackingInfo(first: 1) { number url company } events(first: 1, sortKey: HAPPENED_AT, reverse: true) { nodes { status happenedAt } } }
    }
  }
}`,
  returns: `query DeploiPackReturns($first: Int!, $after: String) {
  orders(first: $first, after: $after, query: "return_status:return_requested", sortKey: UPDATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name email customer { firstName }
      fulfillments(first: 5) { deliveredAt }
      returns(first: 10) { nodes { id status returnLineItems(first: 10) { nodes { ... on ReturnLineItem { id quantity returnReason returnReasonNote customerNote fulfillmentLineItem { lineItem { id title originalUnitPriceSet { shopMoney { amount } } } } } } } } }
    }
  }
}`,
  refunds: `query DeploiPackRefunds($id: ID!) { order(id: $id) { id refunds(first: 20) { id createdAt totalRefundedSet { shopMoney { amount } } } } }`,
  collections: `query DeploiPackCollections($first: Int!, $after: String) {
  collections(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id title handle ruleSet { appliedDisjunctively } products(first: 250) { nodes { id } } }
  }
}`,
  discounts: `query DeploiPackDiscounts($first: Int!, $after: String) {
  codeDiscountNodes(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id codeDiscount { __typename ... on DiscountCodeBasic { title status startsAt endsAt codes(first: 1) { nodes { code } } customerGets { value { __typename ... on DiscountPercentage { percentage } } items { __typename ... on DiscountProducts { products(first: 50) { nodes { id } } } } } } } }
  }
}`,
  payouts: `query DeploiPackPayouts($first: Int!) {
  shopifyPaymentsAccount {
    payouts(first: $first, reverse: true) { nodes { id issuedAt status net { amount } summary { chargesGross { amount } chargesFee { amount } refundsFeeGross { amount } refundsFee { amount } adjustmentsGross { amount } adjustmentsFee { amount } } } }
  }
}`,
  payoutOrders: `query DeploiPackPayoutOrders($query: String!) { shopifyPaymentsAccount { balanceTransactions(first: 250, query: $query) { nodes { type associatedOrder { id } } } } }`,
  productText: `query DeploiPackProductText($id: ID!) { product(id: $id) { id descriptionHtml seo { description } } }`,
  setProduct: `mutation DeploiPackProductUpdate($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id descriptionHtml seo { description } } userErrors { field message } } }`,
  variant: `query DeploiPackVariant($id: ID!) { productVariant(id: $id) { id inventoryPolicy product { id } } }`,
  setPolicy: `mutation DeploiPackSetInventoryPolicy($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id inventoryPolicy } userErrors { field message code } } }`,
  hasProduct: `query DeploiPackCollectionHas($id: ID!, $productId: ID!) { collection(id: $id) { id ruleSet { appliedDisjunctively } hasProduct(id: $productId) } }`,
  removeProducts: `mutation DeploiPackCollectionRemove($id: ID!, $productIds: [ID!]!) { collectionRemoveProducts(id: $id, productIds: $productIds) { job { id done } userErrors { field message } } }`,
  addProducts: `mutation DeploiPackCollectionAdd($id: ID!, $productIds: [ID!]!) { collectionAddProducts(id: $id, productIds: $productIds) { collection { id } userErrors { field message } } }`,
  discountStatus: `query DeploiPackDiscountStatus($id: ID!) { codeDiscountNode(id: $id) { id codeDiscount { __typename ... on DiscountCodeBasic { status } } } }`,
  deactivate: `mutation DeploiPackDiscountDeactivate($id: ID!) { discountCodeDeactivate(id: $id) { codeDiscountNode { id codeDiscount { __typename ... on DiscountCodeBasic { status } } } userErrors { field message code } } }`,
  activate: `mutation DeploiPackDiscountActivate($id: ID!) { discountCodeActivate(id: $id) { codeDiscountNode { id codeDiscount { __typename ... on DiscountCodeBasic { status } } } userErrors { field message code } } }`,
  returnStatus: `query DeploiPackReturnStatus($id: ID!) { return(id: $id) { id status } }`,
  approveReturn: `mutation DeploiPackReturnApprove($input: ReturnApproveRequestInput!) { returnApproveRequest(input: $input) { return { id status } userErrors { field message code } } }`,
  declineReturn: `mutation DeploiPackReturnDecline($input: ReturnDeclineRequestInput!) { returnDeclineRequest(input: $input) { return { id status } userErrors { field message code } } }`,
  suggestedRefund: `query DeploiPackSuggestedRefund($id: ID!, $refundLineItems: [RefundLineItemInput!]) { order(id: $id) { id suggestedRefund(refundLineItems: $refundLineItems) { amountSet { shopMoney { amount } } suggestedTransactions { gateway kind amountSet { shopMoney { amount } } parentTransaction { id } } } } }`,
  refund: `mutation DeploiPackRefund($input: RefundInput!) { refundCreate(input: $input) { refund { id totalRefundedSet { shopMoney { amount } } } userErrors { field message } } }`,
} as const

const opName = (doc: string) => /(?:query|mutation)\s+(\w+)/.exec(doc)![1]
const body = (doc: string, variables?: Record<string, unknown>): GqlBody => ({ query: doc, operationName: opName(doc), ...(variables ? { variables } : {}) })
const refuseOn = (what: string, r: UserErrors | null | undefined) => {
  if (r?.userErrors?.length) throw new CommerceError('refused', `${what}: ${r.userErrors.map(e => e.message).join('; ').slice(0, 240)}`)
}
const notWired = (what: string) => async (): Promise<never> => { throw new CommerceError('not_wired', `${what} is not available through the Shopify Admin API in this build`) }
const amount = (m: { amount: string } | null | undefined) => Math.abs(Number(m?.amount ?? 0))

/** A CommerceStore over an Admin GraphQL function (shopifyGraphql bound to one connection, or a fake in tests). */
export function liveCommerceStore(gql: Gql, opts: { promotedHandles?: string[]; orderWindowDays?: number; now?: () => Date } = {}): CommerceStore {
  const now = opts.now ?? (() => new Date())
  const promoted = new Set([...PROMOTED_HANDLES, ...(opts.promotedHandles ?? [])])
  const call = async <T>(doc: string, variables?: Record<string, unknown>, mutation = false): Promise<T> => {
    try { return await gql<T>(body(doc, variables), { mutation }) } catch (e) {
      if (e instanceof CommerceError) throw e
      if (e instanceof ShopifyApiError) {
        if (e.kind === 'auth') throw new CommerceError('uninstalled', `Shopify refused access (${e.message}); the app may have been uninstalled`)
        if (e.kind === 'throttled') throw new CommerceError('throttled', `Shopify is rate limiting this store: ${e.message}`)
      }
      throw new CommerceError('unreadable', `${opName(doc)}: ${(e as Error).message.slice(0, 200)}`)
    }
  }
  const pages = async <N>(doc: string, pick: (d: never) => Page<N>, vars: Record<string, unknown> = {}, max = 10): Promise<N[]> => {
    const out: N[] = []
    let after: string | null = null
    for (let i = 0; i < max; i++) {
      const d = await call<never>(doc, { first: 50, after, ...vars })
      const p = pick(d)
      out.push(...p.nodes)
      if (!p.pageInfo.hasNextPage || !p.pageInfo.endCursor) break
      after = p.pageInfo.endCursor
    }
    return out
  }
  const productText = async (id: string) => {
    const d = await call<{ product: { descriptionHtml: string; seo: { description: string | null } } | null }>(Q.productText, { id })
    if (!d.product) throw new CommerceError('not_found', 'product not found')
    return d.product
  }
  const discountStatus = async (id: string) => {
    const d = await call<{ codeDiscountNode: { codeDiscount: { status?: string } } | null }>(Q.discountStatus, { id })
    if (!d.codeDiscountNode) throw new CommerceError('not_found', 'discount not found')
    return String(d.codeDiscountNode.codeDiscount.status ?? 'unknown').toLowerCase()
  }
  const returnStatus = async (id: string) => {
    const d = await call<{ return: { status: string } | null }>(Q.returnStatus, { id })
    if (!d.return) throw new CommerceError('not_found', 'return not found')
    return d.return.status.toLowerCase()
  }
  const inCollection = async (id: string, productId: string) => {
    const d = await call<{ collection: { hasProduct: boolean; ruleSet: unknown } | null }>(Q.hasProduct, { id, productId })
    if (!d.collection) throw new CommerceError('not_found', 'collection not found')
    return d.collection
  }
  const label = (b: boolean) => (b ? 'in collection' : 'not in collection')
  const setDiscount = async (id: string, doc: string, key: 'discountCodeDeactivate' | 'discountCodeActivate'): Promise<Change> => {
    const before = await discountStatus(id)
    const r = await call<Record<string, UserErrors>>(doc, { id }, true)
    refuseOn(key, r[key])
    return { before, after: await discountStatus(id) }
  }

  type GProduct = { id: string; title: string; handle: string; status: string; tags: string[]; vendor: string | null; productType: string | null; descriptionHtml: string; seo: { description: string | null }; material: { value: string } | null; care: { value: string } | null; dimensions: { value: string } | null; media: { nodes: { alt: string | null }[] }; variants: { nodes: { id: string; title: string; sku: string | null; barcode: string | null; price: string; inventoryPolicy: 'CONTINUE' | 'DENY'; inventoryQuantity: number | null; inventoryItem: { tracked: boolean } }[] } }
  type GOrder = { id: string; name: string; createdAt: string; cancelledAt: string | null; email: string | null; displayFulfillmentStatus: string; customer: { firstName: string | null } | null; totalPriceSet: Money; lineItems: { nodes: { id: string; title: string; quantity: number; product: { id: string } | null; variant: { id: string } | null; originalUnitPriceSet: Money }[] }; fulfillments: { createdAt: string; deliveredAt: string | null; trackingInfo: { number: string | null; url: string | null; company: string | null }[]; events: { nodes: { status: string; happenedAt: string }[] } }[] }
  type GReturnOrder = { id: string; name: string; email: string | null; customer: { firstName: string | null } | null; fulfillments: { deliveredAt: string | null }[]; returns: { nodes: { id: string; status: string; returnLineItems: { nodes: { id?: string; quantity?: number; returnReason?: string; returnReasonNote?: string; customerNote?: string | null; fulfillmentLineItem?: { lineItem: { id: string; title: string; originalUnitPriceSet: Money } } }[] } }[] } }

  return {
    synthetic: false,
    async shop() { const d = await call<{ shop: { name: string; currencyCode: string } }>(Q.shop); return { name: d.shop.name, currency: d.shop.currencyCode } },
    async policy() { return {} },
    async products() {
      const nodes = await pages<GProduct>(Q.products, (d: { products: Page<GProduct> }) => d.products)
      return nodes.map(p => ({
        id: p.id, title: p.title, handle: p.handle, status: p.status, tags: p.tags, vendor: p.vendor || null, productType: p.productType || null,
        description: plainText(p.descriptionHtml ?? ''), descriptionHtml: p.descriptionHtml ?? '', seoDescription: p.seo?.description ?? null,
        material: p.material?.value ?? null, care: p.care?.value ?? null, dimensions: p.dimensions?.value ?? null,
        imageCount: p.media.nodes.length, imagesMissingAlt: p.media.nodes.filter(m => !m.alt).length,
        variants: p.variants.nodes.map(v => ({ id: v.id, title: v.title, sku: v.sku, barcode: v.barcode, price: v.price, available: v.inventoryItem.tracked ? v.inventoryQuantity ?? 0 : null, tracked: v.inventoryItem.tracked, inventoryPolicy: v.inventoryPolicy })),
      }))
    },
    async orders() {
      const since = new Date(now().getTime() - (opts.orderWindowDays ?? 45) * 864e5).toISOString().slice(0, 10)
      const nodes = await pages<GOrder>(Q.orders, (d: { orders: Page<GOrder> }) => d.orders, { query: `created_at:>=${since}` })
      return nodes.map(o => {
        const f = o.fulfillments[o.fulfillments.length - 1]
        const ev = f?.events.nodes[0]
        return {
          id: o.id, name: o.name, createdAt: o.createdAt, email: o.email ?? '', customerFirstName: o.customer?.firstName ?? 'there', cancelled: Boolean(o.cancelledAt),
          fulfillmentStatus: o.displayFulfillmentStatus === 'FULFILLED' ? 'fulfilled' as const : o.displayFulfillmentStatus === 'PARTIALLY_FULFILLED' ? 'partial' as const : 'unfulfilled' as const,
          items: o.lineItems.nodes.map(l => ({ lineItemId: l.id, productId: l.product?.id ?? '', variantId: l.variant?.id ?? '', title: l.title, quantity: l.quantity, price: l.originalUnitPriceSet.shopMoney.amount })),
          tracking: f ? { number: f.trackingInfo[0]?.number ?? null, url: f.trackingInfo[0]?.url ?? null, carrier: f.trackingInfo[0]?.company ?? null, shippedAt: f.createdAt, lastEvent: ev ? ev.status.replace(/_/g, ' ').toLowerCase() : null, lastEventAt: ev?.happenedAt ?? null, deliveredAt: f.deliveredAt } : null,
          total: o.totalPriceSet.shopMoney.amount,
        }
      })
    },
    async returns() {
      const nodes = await pages<GReturnOrder>(Q.returns, (d: { orders: Page<GReturnOrder> }) => d.orders)
      const out: CReturn[] = []
      for (const o of nodes) for (const r of o.returns.nodes) {
        const li = r.returnLineItems.nodes.find(x => x.fulfillmentLineItem)
        if (!li?.fulfillmentLineItem) continue
        const status = r.status.toLowerCase()
        out.push({
          id: r.id, orderId: o.id, orderName: o.name, status: (['requested', 'open', 'declined', 'closed'].includes(status) ? status : 'closed') as CReturn['status'], requestedAt: now().toISOString(),
          lineItemId: li.fulfillmentLineItem.lineItem.id, itemTitle: li.fulfillmentLineItem.lineItem.title, quantity: li.quantity ?? 1,
          amount: (Number(li.fulfillmentLineItem.lineItem.originalUnitPriceSet.shopMoney.amount) * (li.quantity ?? 1)).toFixed(2),
          reason: li.returnReason ?? 'UNKNOWN', note: [li.returnReasonNote, li.customerNote].filter(Boolean).join(' '), deliveredAt: o.fulfillments.map(f => f.deliveredAt).filter(Boolean).pop() ?? null,
          customerFirstName: o.customer?.firstName ?? 'there', email: o.email ?? '',
        })
      }
      return out
    },
    async refunds(orderId) {
      const d = await call<{ order: { refunds: { id: string; createdAt: string; totalRefundedSet: Money }[] } | null }>(Q.refunds, { id: orderId })
      return (d.order?.refunds ?? []).map(r => ({ id: r.id, orderId, createdAt: r.createdAt, amount: r.totalRefundedSet.shopMoney.amount }))
    },
    async collections() {
      type G = { id: string; title: string; handle: string; ruleSet: unknown; products: { nodes: { id: string }[] } }
      const nodes = await pages<G>(Q.collections, (d: { collections: Page<G> }) => d.collections)
      return nodes.map(c => ({ id: c.id, title: c.title, handle: c.handle, promoted: promoted.has(c.handle), smart: Boolean(c.ruleSet), productIds: c.products.nodes.map(p => p.id) }))
    },
    async discounts() {
      type G = { id: string; codeDiscount: { __typename: string; title?: string; status?: string; startsAt?: string; endsAt?: string | null; codes?: { nodes: { code: string }[] }; customerGets?: { value: { __typename: string; percentage?: number }; items: { __typename: string; products?: { nodes: { id: string }[] } } } } }
      const nodes = await pages<G>(Q.discounts, (d: { codeDiscountNodes: Page<G> }) => d.codeDiscountNodes)
      return nodes.filter(n => n.codeDiscount.__typename === 'DiscountCodeBasic').map(n => {
        const d = n.codeDiscount
        const status = String(d.status ?? '').toLowerCase()
        return { id: n.id, code: d.codes?.nodes[0]?.code ?? '', title: d.title ?? '', percent: Math.round((d.customerGets?.value.percentage ?? 0) * 100), status: (status === 'active' ? 'active' : status === 'scheduled' ? 'scheduled' : 'expired') as CDiscount['status'], startsAt: d.startsAt ?? '', endsAt: d.endsAt ?? null, productIds: d.customerGets?.items.products?.nodes.map(p => p.id) ?? [] }
      })
    },
    async payouts() {
      type G = { id: string; issuedAt: string; status: string; net: { amount: string }; summary: Record<'chargesGross' | 'chargesFee' | 'refundsFeeGross' | 'refundsFee' | 'adjustmentsGross' | 'adjustmentsFee', { amount: string }> }
      const d = await call<{ shopifyPaymentsAccount: { payouts: { nodes: G[] } } | null }>(Q.payouts, { first: 10 })
      if (!d.shopifyPaymentsAccount) return []
      const out: CPayout[] = []
      for (const p of d.shopifyPaymentsAccount.payouts.nodes) {
        const t = await call<{ shopifyPaymentsAccount: { balanceTransactions: { nodes: { type: string; associatedOrder: { id: string } | null }[] } } }>(Q.payoutOrders, { query: `payout_id:${p.id.split('/').pop()}` })
        const s = p.summary, status = p.status.toLowerCase()
        out.push({ id: p.id, issuedAt: p.issuedAt, status: (['paid', 'scheduled', 'in_transit', 'failed'].includes(status) ? status : 'failed') as CPayout['status'], net: p.net.amount,
          gross: amount(s.chargesGross).toFixed(2), fees: (amount(s.chargesFee) + amount(s.refundsFee) + amount(s.adjustmentsFee)).toFixed(2), refunds: amount(s.refundsFeeGross).toFixed(2), adjustments: amount(s.adjustmentsGross).toFixed(2),
          orderIds: [...new Set(t.shopifyPaymentsAccount.balanceTransactions.nodes.filter(x => x.type === 'CHARGE' && x.associatedOrder).map(x => x.associatedOrder!.id))] })
      }
      return out
    },
    announcement: notWired('reading the storefront announcement bar'),
    inbox: async () => [],
    sent: async () => [],
    suppliers: async () => [],
    crew: async () => [],

    async setDescription(productId, html) {
      const before = (await productText(productId)).descriptionHtml ?? ''
      const r = await call<{ productUpdate: UserErrors }>(Q.setProduct, { product: { id: productId, descriptionHtml: html } }, true)
      refuseOn('productUpdate', r.productUpdate)
      return { before, after: (await productText(productId)).descriptionHtml ?? '' }
    },
    async setSeoDescription(productId, text) {
      const before = (await productText(productId)).seo?.description ?? ''
      const r = await call<{ productUpdate: UserErrors }>(Q.setProduct, { product: { id: productId, seo: { description: text ?? '' } } }, true)
      refuseOn('productUpdate', r.productUpdate)
      return { before, after: (await productText(productId)).seo?.description ?? '' }
    },
    async setInventoryPolicy(variantId, policy) {
      const v = await call<{ productVariant: { inventoryPolicy: string; product: { id: string } } | null }>(Q.variant, { id: variantId })
      if (!v.productVariant) throw new CommerceError('not_found', 'variant not found')
      const r = await call<{ productVariantsBulkUpdate: UserErrors }>(Q.setPolicy, { productId: v.productVariant.product.id, variants: [{ id: variantId, inventoryPolicy: policy }] }, true)
      refuseOn('productVariantsBulkUpdate', r.productVariantsBulkUpdate)
      const after = await call<{ productVariant: { inventoryPolicy: string } | null }>(Q.variant, { id: variantId })
      return { before: v.productVariant.inventoryPolicy, after: after.productVariant?.inventoryPolicy ?? 'unknown' }
    },
    async removeFromCollection(id, productId) {
      const c = await inCollection(id, productId)
      if (c.ruleSet) throw new CommerceError('refused', 'this is an automated collection; products leave it only when its conditions change')
      const r = await call<{ collectionRemoveProducts: UserErrors }>(Q.removeProducts, { id, productIds: [productId] }, true)
      refuseOn('collectionRemoveProducts', r.collectionRemoveProducts)
      // the removal runs as a job; the fresh read says whether it has landed
      return { before: label(c.hasProduct), after: label((await inCollection(id, productId)).hasProduct) }
    },
    async addToCollection(id, productId) {
      const c = await inCollection(id, productId)
      const r = await call<{ collectionAddProducts: UserErrors }>(Q.addProducts, { id, productIds: [productId] }, true)
      refuseOn('collectionAddProducts', r.collectionAddProducts)
      return { before: label(c.hasProduct), after: label((await inCollection(id, productId)).hasProduct) }
    },
    deactivateDiscount: id => setDiscount(id, Q.deactivate, 'discountCodeDeactivate'),
    activateDiscount: id => setDiscount(id, Q.activate, 'discountCodeActivate'),
    setAnnouncement: notWired('changing the storefront announcement bar'),
    async approveReturn(id) {
      const before = await returnStatus(id)
      const r = await call<{ returnApproveRequest: UserErrors }>(Q.approveReturn, { input: { id } }, true)
      refuseOn('returnApproveRequest', r.returnApproveRequest)
      return { before, after: await returnStatus(id) }
    },
    async declineReturn(id, reason) {
      const before = await returnStatus(id)
      const r = await call<{ returnDeclineRequest: UserErrors }>(Q.declineReturn, { input: { id, declineReason: 'OTHER', declineNote: reason.slice(0, 255) } }, true)
      refuseOn('returnDeclineRequest', r.returnDeclineRequest)
      return { before, after: await returnStatus(id) }
    },
    async refund(input) {
      const refundLineItems = [{ lineItemId: input.lineItemId, quantity: input.quantity, restockType: 'NO_RESTOCK' }]
      const s = await call<{ order: { suggestedRefund: { amountSet: Money; suggestedTransactions: { gateway: string; kind: string; amountSet: Money; parentTransaction: { id: string } | null }[] } } | null }>(Q.suggestedRefund, { id: input.orderId, refundLineItems })
      if (!s.order) throw new CommerceError('not_found', 'order not found')
      const suggested = Number(s.order.suggestedRefund.amountSet.shopMoney.amount)
      // never refund more than was asked for or more than Shopify says can be refunded for these items
      if (suggested + 0.005 < Number(input.amount)) throw new CommerceError('refused', `Shopify suggests refunding ${suggested.toFixed(2)}, less than the ${input.amount} the policy allows; left for the owner`)
      const transactions = s.order.suggestedRefund.suggestedTransactions.filter(t => t.parentTransaction).map(t => ({ orderId: input.orderId, gateway: t.gateway, kind: 'REFUND', amount: t.amountSet.shopMoney.amount, parentId: t.parentTransaction!.id }))
      const r = await call<{ refundCreate: UserErrors & { refund: { id: string; totalRefundedSet: Money } | null } }>(Q.refund, { input: { orderId: input.orderId, note: input.note.slice(0, 255), notify: true, refundLineItems, transactions } }, true)
      refuseOn('refundCreate', r.refundCreate)
      if (!r.refundCreate.refund) throw new CommerceError('refused', 'refundCreate returned no refund')
      return { id: r.refundCreate.refund.id, amount: r.refundCreate.refund.totalRefundedSet.shopMoney.amount }
    },
    sendEmail: notWired('sending email from the store'),
  }
}

/** The live store for one Shopify connection (expiring tokens, throttling and the outbound boundary are handled by the client). */
export function liveCommerceStoreFor(conn: ConnectionRow, opts: { promotedHandles?: string[] } = {}): CommerceStore {
  return liveCommerceStore(<T>(b: GqlBody, o?: { mutation?: boolean }) => shopifyGraphql<T>(conn, b, { mutation: o?.mutation }), opts)
}
