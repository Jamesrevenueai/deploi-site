/**
 * Everything the library agents read from or write to a store goes through this interface. Two
 * implementations exist: the synthetic one (deterministic data derived from the synthetic Shopify
 * store, used by tests, previews and the demo) and the live one, which is a stub: every method
 * refuses with `not_wired` until the matching Shopify read or write has been built and verified
 * against the official API. Nothing in this build calls a real store.
 */
import type { SynthProduct, SynthState } from '../connectors/shopify/synthetic'
import { getSyntheticState, mutateSynthetic } from '../connectors/shopify/synthetic'
import { admin } from '../db'
import { LibraryError } from './errors'

export type ProductSummary = {
  id: string; title: string; handle: string; status: string; tags: string[]; description: string; imageCount: number
  variants: { id: string; title: string; sku: string | null; price: string; available: number | null; inventoryPolicy: 'CONTINUE' | 'DENY'; tracked: boolean }[]
  /** sales channels the product is published on, by name */
  channels: string[]
}
export type Order = {
  id: string; name: string; createdAt: string; customerFirstName: string; email: string
  status: 'unfulfilled' | 'fulfilled' | 'cancelled'; shippedAt: string | null; trackingNumber: string | null; lastTrackingEvent: string | null; lastTrackingAt: string | null
  totalPrice: string; items: { productId: string; title: string; quantity: number }[]
  /** days the merchant promises to dispatch within */
  promisedDispatchDays: number
}
export type ReturnRequest = {
  id: string; orderId: string; orderName: string; requestedAt: string; reason: string; itemTitle: string; worn: boolean; daysSinceDelivery: number
  status: 'requested' | 'approved' | 'declined'; customerFirstName: string
}
export type Payout = {
  id: string; date: string; amount: string; orderIds: string[]; grossSales: string; feesCharged: string; refundsNetted: string; status: 'paid' | 'pending' | 'missing'
}
export type Discount = { id: string; code: string; percent: number; startsAt: string; endsAt: string | null; status: 'active' | 'expired' | 'scheduled'; createdBy: string }
export type CustomerMessage = { id: string; receivedAt: string; from: string; orderName: string | null; kind: 'where_is_my_order' | 'return' | 'product_question' | 'other'; summary: string }
export type SalesSnapshot = { thisWeek: { orders: number; revenue: number; byProduct: Record<string, number> }; lastWeek: { orders: number; revenue: number }; ranOut: string[] }

export type StoreData = {
  /** true when every read and write here touches only the synthetic store */
  synthetic: boolean
  products(): Promise<ProductSummary[]>
  orders(): Promise<Order[]>
  returns(): Promise<ReturnRequest[]>
  payouts(): Promise<Payout[]>
  discounts(): Promise<Discount[]>
  customerMessages(): Promise<CustomerMessage[]>
  sales(): Promise<SalesSnapshot>
  /** names of the store's sales channels; "Agentic" is Shopify's AI shopping channel */
  channels(): Promise<string[]>
  // ---- writes: each one changes exactly one thing and returns the fresh value as proof
  setProductText(productId: string, field: 'title' | 'description', value: string): Promise<{ before: string; after: string }>
  setInventoryPolicy(variantId: string, policy: 'CONTINUE' | 'DENY'): Promise<{ before: string; after: string }>
  approveReturn(returnId: string): Promise<{ before: string; after: string }>
  createDiscount(d: { code: string; percent: number; endsAt: string | null }): Promise<{ id: string }>
  endDiscount(discountId: string): Promise<{ before: string; after: string }>
}

// ---------------------------------------------------------------- synthetic data
/** Library-specific synthetic records live beside the synthetic Shopify catalogue. */
export type LibrarySynth = {
  returns?: Pick<ReturnRequest, 'id' | 'status'>[]
  discounts?: Discount[]
  descriptions?: Record<string, string>
  agenticPublished?: string[]
}
type StateWithLibrary = SynthState & { library?: LibrarySynth }

const AGENTIC = 'Agentic'
const ONLINE_STORE = 'Online Store'

const day = 864e5
const iso = (now: Date, daysAgo: number, hour = 10) => { const d = new Date(now.getTime() - daysAgo * day); d.setUTCHours(hour, 0, 0, 0); return d.toISOString() }

function describe(p: SynthProduct, lib: LibrarySynth): string {
  if (lib.descriptions?.[p.id] !== undefined) return lib.descriptions[p.id]
  // a deterministic mix of good, thin and missing descriptions so the Listing Writer has work
  const n = Number(p.id.split('/').pop()) % 4
  if (n === 0) return ''
  if (n === 1) return `${p.title}.`
  return `${p.title} made in small batches. Ships within two working days from our warehouse. Returns accepted within 30 days.`
}

function productsFrom(s: StateWithLibrary): ProductSummary[] {
  const lib = s.library ?? {}
  const pubs = new Map((s.publications ?? []).map(p => [p.id, p.title]))
  return s.products.map(p => {
    const n = Number(p.id.split('/').pop())
    const channels = (p.publishedOn ?? []).map(id => pubs.get(id) ?? id)
    if (p.status === 'ACTIVE' && !channels.includes(ONLINE_STORE) && n % 3 !== 1) channels.push(ONLINE_STORE)
    if ((lib.agenticPublished ?? []).includes(p.id) || (p.status === 'ACTIVE' && n % 2 === 0)) channels.push(AGENTIC)
    return {
      id: p.id, title: p.title, handle: p.handle, status: p.status, tags: p.tags, description: describe(p, lib), imageCount: n % 5 === 0 ? 0 : 1 + (n % 3),
      variants: p.variants.map(v => ({ id: v.id, title: v.title, sku: v.sku, price: v.price ?? '0.00', available: v.tracked ? v.levels.reduce((a, l) => a + l.available, 0) : null, inventoryPolicy: v.inventoryPolicy, tracked: v.tracked })),
      channels,
    }
  })
}

function ordersFrom(s: SynthState, now: Date): Order[] {
  const active = s.products.filter(p => p.status === 'ACTIVE' && !p.isGiftCard)
  const pick = (i: number) => active[i % active.length]
  const specs: { daysAgo: number; status: Order['status']; shipped: number | null; tracking: boolean; lastEvent: [string, number] | null; promise: number }[] = [
    { daysAgo: 1, status: 'unfulfilled', shipped: null, tracking: false, lastEvent: null, promise: 2 },
    { daysAgo: 4, status: 'unfulfilled', shipped: null, tracking: false, lastEvent: null, promise: 2 },
    { daysAgo: 6, status: 'unfulfilled', shipped: null, tracking: false, lastEvent: null, promise: 2 },
    { daysAgo: 9, status: 'fulfilled', shipped: 8, tracking: true, lastEvent: ['Label created', 8], promise: 2 },
    { daysAgo: 7, status: 'fulfilled', shipped: 6, tracking: false, lastEvent: null, promise: 2 },
    { daysAgo: 5, status: 'fulfilled', shipped: 4, tracking: true, lastEvent: ['In transit', 1], promise: 2 },
    { daysAgo: 3, status: 'fulfilled', shipped: 2, tracking: true, lastEvent: ['Delivered', 0], promise: 2 },
    { daysAgo: 12, status: 'fulfilled', shipped: 11, tracking: true, lastEvent: ['Delivered', 9], promise: 2 },
    { daysAgo: 15, status: 'cancelled', shipped: null, tracking: false, lastEvent: null, promise: 2 },
    { daysAgo: 2, status: 'fulfilled', shipped: 1, tracking: true, lastEvent: ['In transit', 0], promise: 2 },
    { daysAgo: 10, status: 'fulfilled', shipped: 9, tracking: true, lastEvent: ['Delivered', 7], promise: 2 },
    { daysAgo: 13, status: 'fulfilled', shipped: 12, tracking: true, lastEvent: ['Delivered', 10], promise: 2 },
  ]
  const names = ['Ava', 'Ben', 'Chloe', 'Dev', 'Esme', 'Finn', 'Grace', 'Hugo', 'Iris', 'Jude', 'Kit', 'Lena']
  return specs.map((o, i) => {
    const p = pick(i), q = pick(i + 5)
    const price = Number(p.variants[0].price ?? '20') * 1 + Number(q.variants[0].price ?? '20') * (i % 2)
    return {
      id: `gid://shopify/Order/${7001 + i}`, name: `#${1041 + i}`, createdAt: iso(now, o.daysAgo), customerFirstName: names[i], email: `${names[i].toLowerCase()}@customer.example`,
      status: o.status, shippedAt: o.shipped === null ? null : iso(now, o.shipped, 15), trackingNumber: o.tracking ? `SYN${100200 + i}` : null,
      lastTrackingEvent: o.lastEvent ? o.lastEvent[0] : null, lastTrackingAt: o.lastEvent ? iso(now, o.lastEvent[1], 16) : null,
      totalPrice: price.toFixed(2), items: [{ productId: p.id, title: p.title, quantity: 1 }, ...(i % 2 ? [{ productId: q.id, title: q.title, quantity: 1 }] : [])], promisedDispatchDays: o.promise,
    }
  })
}

function returnsFrom(s: StateWithLibrary, orders: Order[]): ReturnRequest[] {
  const delivered = orders.filter(o => o.lastTrackingEvent === 'Delivered')
  const status = new Map((s.library?.returns ?? []).map(r => [r.id, r.status]))
  const specs: { reason: string; worn: boolean; days: number }[] = [
    { reason: 'Wrong size', worn: false, days: 6 },
    { reason: 'Changed my mind', worn: true, days: 12 },
    { reason: 'Arrived damaged', worn: false, days: 3 },
    { reason: 'Not as described', worn: false, days: 41 },
  ]
  return specs.map((r, i) => {
    const o = delivered[i % Math.max(1, delivered.length)]
    const id = `gid://shopify/Return/${8001 + i}`
    return { id, orderId: o?.id ?? 'gid://shopify/Order/0', orderName: o?.name ?? '#0', requestedAt: o?.lastTrackingAt ?? new Date(0).toISOString(), reason: r.reason, itemTitle: o?.items[0]?.title ?? 'Item', worn: r.worn, daysSinceDelivery: r.days, status: status.get(id) ?? 'requested', customerFirstName: o?.customerFirstName ?? 'Customer' }
  })
}

function payoutsFrom(orders: Order[], now: Date): Payout[] {
  const paid = orders.filter(o => o.status !== 'cancelled')
  const chunk = (a: Order[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))
  return chunk(paid, 4).map((group, i) => {
    const gross = group.reduce((s, o) => s + Number(o.totalPrice), 0)
    // the second payout carries a fee above the expected 2.9% + 0.30, the third was never paid out
    const rate = i === 1 ? 0.039 : 0.029
    const fees = gross * rate + group.length * 0.3
    const refunds = i === 0 ? 24.0 : 0
    return { id: `gid://shopify/Payout/${9001 + i}`, date: iso(now, 14 - i * 5, 9), amount: (gross - fees - refunds).toFixed(2), orderIds: group.map(o => o.id), grossSales: gross.toFixed(2), feesCharged: fees.toFixed(2), refundsNetted: refunds.toFixed(2), status: i === 2 ? 'missing' : 'paid' }
  })
}

function discountsFrom(s: StateWithLibrary, now: Date): Discount[] {
  const own = s.library?.discounts ?? []
  const base: Discount[] = [
    { id: 'gid://shopify/DiscountCode/5001', code: 'SPRING10', percent: 10, startsAt: iso(now, 40), endsAt: iso(now, 3), status: 'active', createdBy: 'merchant' },
    { id: 'gid://shopify/DiscountCode/5002', code: 'WELCOME5', percent: 5, startsAt: iso(now, 120), endsAt: null, status: 'active', createdBy: 'merchant' },
  ]
  return [...base.filter(b => !own.some(o => o.id === b.id)), ...own]
}

function messagesFrom(orders: Order[], now: Date): CustomerMessage[] {
  const late = orders.filter(o => o.status === 'unfulfilled')
  return [
    { id: 'msg-1', receivedAt: iso(now, 0, 8), from: late[1]?.email ?? 'ben@customer.example', orderName: late[1]?.name ?? '#1042', kind: 'where_is_my_order', summary: 'Asks where the order is; ordered four days ago' },
    { id: 'msg-2', receivedAt: iso(now, 1, 14), from: 'grace@customer.example', orderName: null, kind: 'product_question', summary: 'Asks whether the throw blanket is machine washable' },
    { id: 'msg-3', receivedAt: iso(now, 1, 18), from: 'hugo@customer.example', orderName: orders[7]?.name ?? '#1048', kind: 'return', summary: 'Wants to return a set that arrived damaged' },
  ]
}

function salesFrom(orders: Order[], products: ProductSummary[], now: Date): SalesSnapshot {
  const age = (o: Order) => (now.getTime() - new Date(o.createdAt).getTime()) / day
  const live = orders.filter(o => o.status !== 'cancelled')
  const thisWeek = live.filter(o => age(o) < 7), lastWeek = live.filter(o => age(o) >= 7 && age(o) < 14)
  const byProduct: Record<string, number> = {}
  for (const o of thisWeek) for (const it of o.items) byProduct[it.title] = (byProduct[it.title] ?? 0) + it.quantity
  const sum = (a: Order[]) => Math.round(a.reduce((s, o) => s + Number(o.totalPrice), 0) * 100) / 100
  return { thisWeek: { orders: thisWeek.length, revenue: sum(thisWeek), byProduct }, lastWeek: { orders: lastWeek.length, revenue: sum(lastWeek) }, ranOut: products.filter(p => p.status === 'ACTIVE' && p.variants.some(v => v.tracked && (v.available ?? 1) <= 0)).map(p => p.title) }
}

export function syntheticStoreData(connectionId: string, now = new Date()): StoreData {
  const state = async (): Promise<StateWithLibrary> => {
    const s = await getSyntheticState(connectionId)
    if (!s) throw new LibraryError('not_found', 'no synthetic store for this connection')
    return s as StateWithLibrary
  }
  const orders = async () => ordersFrom(await state(), now)
  const products = async () => productsFrom(await state())
  const mutate = (fn: (s: StateWithLibrary) => void) => mutateSynthetic(connectionId, s => fn(s as StateWithLibrary))
  return {
    synthetic: true,
    products,
    orders,
    returns: async () => returnsFrom(await state(), await orders()),
    payouts: async () => payoutsFrom(await orders(), now),
    discounts: async () => discountsFrom(await state(), now),
    customerMessages: async () => messagesFrom(await orders(), now),
    sales: async () => salesFrom(await orders(), await products(), now),
    channels: async () => [ONLINE_STORE, 'Point of Sale', AGENTIC],
    async setProductText(productId, field, value) {
      let before = ''
      await mutate(s => {
        const p = s.products.find(x => x.id === productId)
        if (!p) throw new LibraryError('not_found', 'product not found')
        if (field === 'title') { before = p.title; p.title = value } else { before = describe(p, s.library ?? {}); s.library = { ...(s.library ?? {}), descriptions: { ...(s.library?.descriptions ?? {}), [productId]: value } } }
        p.updatedAt = now.toISOString()
      })
      const fresh = (await products()).find(p => p.id === productId)!
      return { before, after: field === 'title' ? fresh.title : fresh.description }
    },
    async setInventoryPolicy(variantId, policy) {
      let before = ''
      await mutate(s => {
        const v = s.products.flatMap(p => p.variants).find(x => x.id === variantId)
        if (!v) throw new LibraryError('not_found', 'variant not found')
        before = v.inventoryPolicy; v.inventoryPolicy = policy
      })
      const fresh = (await products()).flatMap(p => p.variants).find(v => v.id === variantId)!
      return { before, after: fresh.inventoryPolicy }
    },
    async approveReturn(returnId) {
      const r = (await this.returns()).find(x => x.id === returnId)
      if (!r) throw new LibraryError('not_found', 'return not found')
      await mutate(s => { s.library = { ...(s.library ?? {}), returns: [...(s.library?.returns ?? []).filter(x => x.id !== returnId), { id: returnId, status: 'approved' }] } })
      return { before: r.status, after: 'approved' }
    },
    async createDiscount(d) {
      const id = `gid://shopify/DiscountCode/${6000 + Math.floor(Math.random() * 1000)}`
      await mutate(s => { s.library = { ...(s.library ?? {}), discounts: [...(s.library?.discounts ?? []), { id, code: d.code, percent: d.percent, startsAt: now.toISOString(), endsAt: d.endsAt, status: 'active', createdBy: 'deploi' }] } })
      return { id }
    },
    async endDiscount(discountId) {
      const all = await this.discounts()
      const d = all.find(x => x.id === discountId)
      if (!d) throw new LibraryError('not_found', 'discount not found')
      await mutate(s => { s.library = { ...(s.library ?? {}), discounts: [...(s.library?.discounts ?? []).filter(x => x.id !== discountId), { ...d, status: 'expired', endsAt: now.toISOString() }] } })
      return { before: d.status, after: 'expired' }
    },
  }
}

// ---------------------------------------------------------------- live stub
const NOT_WIRED = 'live Shopify reads and writes for the agent library are not wired in this build; every call is refused until it is built and verified against the Admin API'
const refuse = (what: string) => async (): Promise<never> => { throw new LibraryError('not_wired', `${what}: ${NOT_WIRED}`) }

/** Every live call refuses. This is deliberate: the library ships preview-only until each read is verified. */
export function liveStoreDataStub(): StoreData {
  return {
    synthetic: false,
    products: refuse('products'), orders: refuse('orders'), returns: refuse('returns'), payouts: refuse('payouts'), discounts: refuse('discounts'),
    customerMessages: refuse('customer messages'), sales: refuse('sales'), channels: refuse('sales channels'),
    setProductText: refuse('product text write'), setInventoryPolicy: refuse('inventory policy write'), approveReturn: refuse('return approval'),
    createDiscount: refuse('discount creation'), endDiscount: refuse('ending a discount'),
  }
}

/** The data source for an organization's active store: synthetic stores get data, real stores get the stub. */
export async function storeDataFor(orgId: string, now = new Date()): Promise<{ data: StoreData; connectionId: string | null }> {
  const conn = await admin(db => db.one<{ id: string; is_synthetic: boolean }>(`select id, is_synthetic from store_connections where org_id = $1 and status = 'active' order by created_at limit 1`, [orgId]))
  if (!conn) throw new LibraryError('needs_setup', 'connect a store first', { step: 'connect' })
  return { data: conn.is_synthetic ? syntheticStoreData(conn.id, now) : liveStoreDataStub(), connectionId: conn.id }
}
