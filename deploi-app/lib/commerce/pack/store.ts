/**
 * What the commerce pack reads from and writes to a store. Two implementations:
 *  - synthetic (below): the synthetic Shopify store's JSON state (lib/connectors/shopify/synthetic.ts), used by tests,
 *    the scenario seeder and demos; faults can be injected per operation ('commerce.<method>').
 *  - live (live-store.ts): Admin GraphQL reads and writes, built and tested against a fake GraphQL layer, not yet
 *    verified against a real store.
 * Every write changes exactly one thing and returns { before, after } from a fresh read.
 */
import { admin } from '../../db'
import { getSyntheticState, mutateSynthetic, type SynthCommerce, type SynthFault, type SynthState } from '../../connectors/shopify/synthetic'

export type CommerceErrorCode = 'refused' | 'not_wired' | 'uninstalled' | 'not_found' | 'throttled' | 'unreadable'
export class CommerceError extends Error {
  constructor(public code: CommerceErrorCode, message: string) { super(message); this.name = 'CommerceError' }
}

export type CVariant = { id: string; title: string; sku: string | null; barcode: string | null; price: string; available: number | null; tracked: boolean; inventoryPolicy: 'CONTINUE' | 'DENY' }
export type CProduct = {
  id: string; title: string; handle: string; status: string; tags: string[]; vendor: string | null; productType: string | null
  /** plain text of the description */
  description: string; descriptionHtml: string; seoDescription: string | null
  material: string | null; care: string | null; dimensions: string | null
  imageCount: number; imagesMissingAlt: number; variants: CVariant[]
}
export type COrder = {
  id: string; name: string; createdAt: string; email: string; customerFirstName: string; cancelled: boolean
  fulfillmentStatus: 'unfulfilled' | 'partial' | 'fulfilled'
  items: { lineItemId: string; productId: string; variantId: string; title: string; quantity: number; price: string }[]
  tracking: { number: string | null; url: string | null; carrier: string | null; shippedAt: string; lastEvent: string | null; lastEventAt: string | null; deliveredAt: string | null } | null
  total: string
}
export type CReturn = { id: string; orderId: string; orderName: string; status: 'requested' | 'open' | 'declined' | 'closed'; requestedAt: string; lineItemId: string; itemTitle: string; quantity: number; amount: string; reason: string; note: string; deliveredAt: string | null; customerFirstName: string; email: string }
export type CRefund = { id: string; orderId: string; createdAt: string; amount: string }
export type CCollection = { id: string; title: string; handle: string; promoted: boolean; smart: boolean; productIds: string[] }
export type CDiscount = { id: string; code: string; title: string; percent: number; status: 'active' | 'expired' | 'scheduled'; startsAt: string; endsAt: string | null; productIds: string[] }
export type CPayout = { id: string; issuedAt: string; status: 'paid' | 'scheduled' | 'in_transit' | 'failed'; net: string; gross: string; fees: string; refunds: string; adjustments: string; orderIds: string[] }
export type CMail = { id: string; receivedAt: string; from: string; subject: string; text: string; inReplyTo: string | null }
export type CSent = { id: string; sentAt: string; to: string; subject: string; text: string; inReplyTo: string | null; agentKey: string }
export type StorePolicy = { returnWindowDays: number; promisedDispatchDays: number; feeRatePct: number; feeFixed: number }
export type Supplier = { vendor: string; name: string; email: string; leadTimeDays: number }
export type CrewMember = { id: string; name: string; role: 'packer' | 'warehouse'; address: string }
export type Change = { before: string; after: string }

export type CommerceStore = {
  synthetic: boolean
  shop(): Promise<{ name: string; currency: string }>
  /** store-side defaults; agent settings override them */
  policy(): Promise<Partial<StorePolicy>>
  products(): Promise<CProduct[]>
  orders(): Promise<COrder[]>
  returns(): Promise<CReturn[]>
  refunds(orderId: string): Promise<CRefund[]>
  collections(): Promise<CCollection[]>
  discounts(): Promise<CDiscount[]>
  /** storefront announcement bar text, null when none */
  announcement(): Promise<string | null>
  payouts(): Promise<CPayout[]>
  /** messages from customers and suppliers in the store's mailbox */
  inbox(): Promise<CMail[]>
  /** messages agents sent from this store */
  sent(): Promise<CSent[]>
  suppliers(): Promise<Supplier[]>
  crew(): Promise<CrewMember[]>
  // ---- writes
  setDescription(productId: string, html: string): Promise<Change>
  setSeoDescription(productId: string, text: string | null): Promise<Change>
  setInventoryPolicy(variantId: string, policy: 'CONTINUE' | 'DENY'): Promise<Change>
  removeFromCollection(collectionId: string, productId: string): Promise<Change>
  addToCollection(collectionId: string, productId: string): Promise<Change>
  deactivateDiscount(discountId: string): Promise<Change>
  activateDiscount(discountId: string): Promise<Change>
  setAnnouncement(text: string | null): Promise<Change>
  approveReturn(returnId: string): Promise<Change>
  declineReturn(returnId: string, reason: string): Promise<Change>
  refund(input: { orderId: string; lineItemId: string; quantity: number; amount: string; note: string }): Promise<{ id: string; amount: string }>
  sendEmail(m: { to: string; subject: string; text: string; inReplyTo: string | null; agentKey: string }): Promise<{ id: string }>
}

export const plainText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
export const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length

// ---------------------------------------------------------------- synthetic
const lower = <T extends string>(s: string) => s.toLowerCase() as T

function productsOf(s: SynthState): CProduct[] {
  const c = s.commerce!
  return s.products.filter(p => !p.isGiftCard).map(p => {
    const i = c.info[p.id] ?? {}
    const html = i.descriptionHtml ?? ''
    return {
      id: p.id, title: p.title, handle: p.handle, status: p.status, tags: p.tags, vendor: i.vendor ?? null, productType: i.productType ?? null,
      description: plainText(html), descriptionHtml: html, seoDescription: i.seoDescription ?? null, material: i.material ?? null, care: i.care ?? null, dimensions: i.dimensions ?? null,
      imageCount: (i.images ?? []).length, imagesMissingAlt: (i.images ?? []).filter(x => !x.alt).length,
      variants: p.variants.map(v => ({ id: v.id, title: v.title, sku: v.sku, barcode: v.barcodes?.[0] ?? null, price: v.price ?? '0.00', available: v.tracked ? v.levels.reduce((a, l) => a + l.available, 0) : null, tracked: v.tracked, inventoryPolicy: v.inventoryPolicy })),
    }
  })
}

function ordersOf(s: SynthState): COrder[] {
  return s.commerce!.orders.map(o => {
    const f = o.fulfillments[o.fulfillments.length - 1]
    return {
      id: o.id, name: o.name, createdAt: o.createdAt, email: o.email, customerFirstName: o.customerFirstName, cancelled: Boolean(o.cancelledAt),
      fulfillmentStatus: o.fulfillmentStatus === 'FULFILLED' ? 'fulfilled' : o.fulfillmentStatus === 'PARTIALLY_FULFILLED' ? 'partial' : 'unfulfilled',
      items: o.lineItems.map(l => ({ lineItemId: l.id, productId: l.productId, variantId: l.variantId, title: l.title, quantity: l.quantity, price: l.price })),
      tracking: f ? { number: f.trackingNumber, url: f.trackingUrl, carrier: f.carrier, shippedAt: f.createdAt, lastEvent: f.lastEvent, lastEventAt: f.lastEventAt, deliveredAt: f.deliveredAt } : null,
      total: o.lineItems.reduce((a, l) => a + Number(l.price) * l.quantity, 0).toFixed(2),
    }
  })
}

function returnsOf(s: SynthState): CReturn[] {
  const orders = ordersOf(s)
  return s.commerce!.returns.map(r => {
    const o = orders.find(x => x.id === r.orderId)
    const li = o?.items.find(x => x.lineItemId === r.lineItemId)
    return { id: r.id, orderId: r.orderId, orderName: o?.name ?? '', status: lower(r.status), requestedAt: r.requestedAt, lineItemId: r.lineItemId, itemTitle: li?.title ?? 'item', quantity: r.quantity, amount: (Number(li?.price ?? 0) * r.quantity).toFixed(2), reason: r.reason, note: r.note, deliveredAt: o?.tracking?.deliveredAt ?? null, customerFirstName: o?.customerFirstName ?? 'there', email: o?.email ?? '' }
  })
}

/** The synthetic connection behind an organization's commerce store, with fault handling per operation. */
export function syntheticCommerceStore(connectionId: string, now = () => new Date()): CommerceStore {
  // a fault is consumed in its own write so it fires once even when the operation itself fails
  const fault = async (op: string): Promise<SynthFault['mode'] | null> => {
    let mode: SynthFault['mode'] | null = null
    await mutateSynthetic(connectionId, s => {
      const f = s.faults.find(x => x.op === `commerce.${op}` && x.remaining > 0)
      if (!f) return
      f.remaining--; s.faults = s.faults.filter(x => x.remaining > 0); mode = f.mode
    })
    if (mode === 'uninstall_mid_run') {
      await admin(db => db.query(`update store_connections set status = 'uninstalled', status_reason = 'app uninstalled (synthetic fault)' where id = $1`, [connectionId]))
      throw new CommerceError('uninstalled', 'the app was uninstalled from this store')
    }
    if (mode === 'read_error') throw new CommerceError('unreadable', `${op}: connection reset (synthetic)`)
    return mode
  }
  /** a throttled call is waited out and retried once, as the GraphQL client does */
  const guard = async (op: string) => {
    const conn = await admin(db => db.one<{ status: string }>('select status from store_connections where id = $1', [connectionId]))
    if (!conn || conn.status === 'uninstalled') throw new CommerceError('uninstalled', 'the app is not installed on this store')
    let mode = await fault(op)
    if (mode === 'throttle_once') mode = await fault(op)
    return mode
  }
  const state = async () => {
    const s = await getSyntheticState(connectionId)
    if (!s?.commerce) throw new CommerceError('not_found', 'this synthetic store has no commerce data')
    return s as SynthState & { commerce: SynthCommerce }
  }
  const read = <T>(op: string, fn: (s: SynthState & { commerce: SynthCommerce }) => T) => async (): Promise<T> => { await guard(op); return fn(await state()) }
  /** apply a write; 'user_error' refuses, 'write_does_not_stick' reports success without changing anything */
  const write = async (op: string, fn: (s: SynthState & { commerce: SynthCommerce }) => void) => {
    const mode = await guard(op)
    if (mode === 'user_error') throw new CommerceError('refused', `${op}: Shopify refused the change (synthetic userErrors)`)
    if (mode === 'write_does_not_stick') return
    await mutateSynthetic(connectionId, s => fn(s as SynthState & { commerce: SynthCommerce }))
  }
  const store: CommerceStore = {
    synthetic: true,
    shop: read('shop', s => ({ name: s.shop.name, currency: s.shop.currencyCode })),
    policy: read('policy', s => s.commerce.policy),
    products: read('products', productsOf),
    orders: read('orders', ordersOf),
    returns: read('returns', returnsOf),
    refunds: async orderId => { await guard('refunds'); return (await state()).commerce.refunds.filter(r => r.orderId === orderId).map(r => ({ id: r.id, orderId: r.orderId, createdAt: r.createdAt, amount: r.amount })) },
    collections: read('collections', s => s.commerce.collections.map(c => ({ ...c, productIds: [...c.productIds] }))),
    discounts: read('discounts', s => s.commerce.discounts.map(d => ({ ...d, status: lower<CDiscount['status']>(d.status), productIds: [...d.productIds] }))),
    announcement: read('announcement', s => s.commerce.announcement),
    payouts: read('payouts', s => s.commerce.payouts.map(p => ({ ...p, status: lower<CPayout['status']>(p.status) }))),
    inbox: read('inbox', s => s.commerce.mailbox.map(m => ({ id: m.id, receivedAt: m.receivedAt, from: m.from, subject: m.subject, text: m.text, inReplyTo: m.inReplyTo }))),
    sent: read('sent', s => s.commerce.outbox.map(m => ({ ...m }))),
    suppliers: read('suppliers', s => s.commerce.suppliers),
    crew: read('crew', s => s.commerce.crew),

    async setDescription(productId, html) {
      const before = (await state()).commerce.info[productId]?.descriptionHtml ?? ''
      await write('setDescription', s => { s.commerce.info[productId] = { ...(s.commerce.info[productId] ?? {}), descriptionHtml: html } })
      return { before, after: (await state()).commerce.info[productId]?.descriptionHtml ?? '' }
    },
    async setSeoDescription(productId, text) {
      const before = (await state()).commerce.info[productId]?.seoDescription ?? ''
      await write('setSeoDescription', s => { s.commerce.info[productId] = { ...(s.commerce.info[productId] ?? {}), seoDescription: text } })
      return { before: before ?? '', after: (await state()).commerce.info[productId]?.seoDescription ?? '' }
    },
    async setInventoryPolicy(variantId, policy) {
      const v = (s: SynthState) => s.products.flatMap(p => p.variants).find(x => x.id === variantId)
      const cur = v(await state())
      if (!cur) throw new CommerceError('not_found', 'variant not found')
      await write('setInventoryPolicy', s => { v(s)!.inventoryPolicy = policy })
      return { before: cur.inventoryPolicy, after: v(await state())!.inventoryPolicy }
    },
    async removeFromCollection(collectionId, productId) {
      const col = (s: SynthState) => s.commerce!.collections.find(c => c.id === collectionId)
      const c = col(await state())
      if (!c) throw new CommerceError('not_found', 'collection not found')
      if (c.smart) throw new CommerceError('refused', `${c.title} is an automated collection; products leave it only when its conditions change`)
      await write('removeFromCollection', s => { const x = col(s)!; x.productIds = x.productIds.filter(id => id !== productId) })
      return { before: c.productIds.includes(productId) ? 'in collection' : 'not in collection', after: col(await state())!.productIds.includes(productId) ? 'in collection' : 'not in collection' }
    },
    async addToCollection(collectionId, productId) {
      const col = (s: SynthState) => s.commerce!.collections.find(c => c.id === collectionId)
      const c = col(await state())
      if (!c) throw new CommerceError('not_found', 'collection not found')
      await write('addToCollection', s => { const x = col(s)!; if (!x.productIds.includes(productId)) x.productIds.push(productId) })
      return { before: c.productIds.includes(productId) ? 'in collection' : 'not in collection', after: col(await state())!.productIds.includes(productId) ? 'in collection' : 'not in collection' }
    },
    async deactivateDiscount(id) { return setDiscount(id, 'EXPIRED', 'deactivateDiscount') },
    async activateDiscount(id) { return setDiscount(id, 'ACTIVE', 'activateDiscount') },
    async setAnnouncement(text) {
      const before = (await state()).commerce.announcement ?? ''
      await write('setAnnouncement', s => { s.commerce.announcement = text })
      return { before, after: (await state()).commerce.announcement ?? '' }
    },
    async approveReturn(id) { return setReturn(id, 'OPEN', 'approveReturn') },
    async declineReturn(id) { return setReturn(id, 'DECLINED', 'declineReturn') },
    async refund(input) {
      const id = `gid://shopify/Refund/${Math.floor(100000 + Math.random() * 899999)}`
      await write('refund', s => { s.commerce.refunds.push({ id, orderId: input.orderId, createdAt: now().toISOString(), amount: input.amount, lineItemIds: [input.lineItemId], note: input.note }) })
      return { id, amount: input.amount }
    },
    async sendEmail(m) {
      const id = `sent-${Math.random().toString(36).slice(2, 10)}`
      await write('sendEmail', s => { s.commerce.outbox.push({ id, sentAt: now().toISOString(), ...m }) })
      return { id }
    },
  }
  async function setDiscount(id: string, status: 'ACTIVE' | 'EXPIRED', op: string): Promise<Change> {
    const d = (s: SynthState) => s.commerce!.discounts.find(x => x.id === id)
    const cur = d(await state())
    if (!cur) throw new CommerceError('not_found', 'discount not found')
    await write(op, s => { d(s)!.status = status })
    return { before: cur.status.toLowerCase(), after: d(await state())!.status.toLowerCase() }
  }
  async function setReturn(id: string, status: 'OPEN' | 'DECLINED', op: string): Promise<Change> {
    const r = (s: SynthState) => s.commerce!.returns.find(x => x.id === id)
    const cur = r(await state())
    if (!cur) throw new CommerceError('not_found', 'return not found')
    await write(op, s => { r(s)!.status = status })
    return { before: cur.status.toLowerCase(), after: r(await state())!.status.toLowerCase() }
  }
  return store
}
