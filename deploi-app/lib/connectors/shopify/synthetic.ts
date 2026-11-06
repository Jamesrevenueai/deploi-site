/**
 * Synthetic Shopify store: answers this app's Admin GraphQL operations from a JSON state kept in
 * synthetic_store_state, so demos and tests exercise the real connector code path (GraphQL
 * documents, response shapes, userErrors, throttling) without touching a real merchant.
 * It is only reachable for connections flagged is_synthetic. Fault injection covers the failure
 * paths: platform refusal, lost responses, writes that do not stick, unreadable records.
 */
import { admin } from '../../db'
import { REQUIRED_SCOPES, OPTIONAL_SCOPES } from './config'
import type { GqlVariant } from './normalize'

export type SynthLevel = { locationId: string; available: number; onHand: number; committed: number }
export type SynthVariant = { id: string; title: string; sku: string | null; inventoryPolicy: 'CONTINUE' | 'DENY'; sellingPlanGroupsCount: number; inventoryItemId: string; tracked: boolean; levels: SynthLevel[]; price?: string; compareAtPrice?: string | null; barcodes?: string[] }
export type SynthProduct = { id: string; title: string; handle: string; status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | 'UNLISTED'; tags: string[]; isGiftCard: boolean; requiresSellingPlan: boolean; sellingPlanGroupsCount: number; updatedAt: string; variants: SynthVariant[]; publishedOn?: string[]; scheduled?: { publicationId: string; publishDate: string }[] }
export type SynthFault = { op: string; mode: 'user_error' | 'lost_response_applied' | 'lost_response_not_applied' | 'write_does_not_stick' | 'read_error' | 'throttle_once' | 'uninstall_mid_run'; remaining: number }
export type SynthState = {
  shop: { name: string; myshopifyDomain: string; ianaTimezone: string; currencyCode: string }
  locations: { id: string; name: string }[]
  publications?: { id: string; title: string }[]
  /** variants with Markets/B2B fixed prices (a base-price change would not reach those buyers) */
  priceListOverrides?: string[]
  products: SynthProduct[]
  faults: SynthFault[]
  writeLog: { at: string; op: string; variantIds: string[]; inventoryPolicy: string }[]
  subscriptions: { id: string; name: string; status: string; test: boolean; trialDays: number; currentPeriodEnd: string | null; createdAt: string }[]
  /** what the merchant has granted (currentAppInstallation.accessScopes); absent = everything the app can ask for */
  accessScopes?: string[]
  /** orders, returns, refunds, collections, discounts, payouts and mail for the commerce pack (see SynthCommerce) */
  commerce?: SynthCommerce
}

// ---------------------------------------------------------------- commerce pack data
// Everything below is invented. The commerce pack (lib/commerce/pack) reads and writes it through its synthetic
// CommerceStore; the scenario seeders put one problem each into a quiet store so a sweep finds exactly that work.
export type SynthProductInfo = { vendor?: string; productType?: string; descriptionHtml?: string; seoDescription?: string | null; images?: { alt: string | null }[]; material?: string; care?: string; dimensions?: string }
export type SynthFulfillment = { id: string; createdAt: string; trackingNumber: string | null; trackingUrl: string | null; carrier: string | null; lastEvent: string | null; lastEventAt: string | null; deliveredAt: string | null }
export type SynthOrder = {
  id: string; name: string; createdAt: string; email: string; customerFirstName: string; cancelledAt: string | null
  fulfillmentStatus: 'UNFULFILLED' | 'PARTIALLY_FULFILLED' | 'FULFILLED'
  lineItems: { id: string; productId: string; variantId: string; title: string; quantity: number; price: string }[]
  fulfillments: SynthFulfillment[]
}
export type SynthReturn = { id: string; orderId: string; status: 'REQUESTED' | 'OPEN' | 'DECLINED' | 'CLOSED'; requestedAt: string; lineItemId: string; quantity: number; reason: string; note: string }
export type SynthRefund = { id: string; orderId: string; createdAt: string; amount: string; lineItemIds: string[]; note: string }
export type SynthCollection = { id: string; title: string; handle: string; promoted: boolean; smart: boolean; productIds: string[] }
export type SynthDiscount = { id: string; code: string; title: string; percent: number; status: 'ACTIVE' | 'EXPIRED' | 'SCHEDULED'; startsAt: string; endsAt: string | null; productIds: string[] }
export type SynthPayout = { id: string; issuedAt: string; status: 'PAID' | 'SCHEDULED' | 'IN_TRANSIT' | 'FAILED'; net: string; gross: string; fees: string; refunds: string; adjustments: string; orderIds: string[] }
export type SynthMail = { id: string; receivedAt: string; from: string; to: string; subject: string; text: string; inReplyTo: string | null }
export type SynthSent = { id: string; sentAt: string; to: string; subject: string; text: string; inReplyTo: string | null; agentKey: string }
export type SynthCommerce = {
  info: Record<string, SynthProductInfo>
  orders: SynthOrder[]
  returns: SynthReturn[]
  refunds: SynthRefund[]
  collections: SynthCollection[]
  discounts: SynthDiscount[]
  /** the storefront announcement bar text */
  announcement: string | null
  payouts: SynthPayout[]
  /** the store's test mailbox: messages from customers and suppliers */
  mailbox: SynthMail[]
  /** everything an agent sent from the synthetic store (never leaves Deploi) */
  outbox: SynthSent[]
  suppliers: { vendor: string; name: string; email: string; leadTimeDays: number }[]
  crew: { id: string; name: string; role: 'packer' | 'warehouse'; address: string }[]
  policy: { returnWindowDays: number; promisedDispatchDays: number; feeRatePct: number; feeFixed: number }
}

export class SyntheticNetworkError extends Error { constructor(m: string) { super(m); this.name = 'SyntheticNetworkError' } }

export async function getSyntheticState(connectionId: string): Promise<SynthState | null> {
  return admin(async db => (await db.one<{ state: SynthState }>('select state from synthetic_store_state where connection_id = $1', [connectionId]))?.state ?? null)
}

export async function setSyntheticState(connectionId: string, state: SynthState) {
  await admin(db => db.query(
    `insert into synthetic_store_state (connection_id, state) values ($1,$2) on conflict (connection_id) do update set state = excluded.state, updated_at = now()`,
    [connectionId, JSON.stringify(state)]))
}

/** Change the synthetic store outside Deploi (what a merchant or another app would do). */
export async function mutateSynthetic(connectionId: string, fn: (s: SynthState) => void) {
  await admin(async db => {
    const r = await db.one<{ state: SynthState }>('select state from synthetic_store_state where connection_id = $1 for update', [connectionId])
    if (!r) throw new Error('no synthetic store for this connection')
    fn(r.state)
    await db.query('update synthetic_store_state set state = $2, updated_at = now() where connection_id = $1', [connectionId, JSON.stringify(r.state)])
  })
}

export async function injectFault(connectionId: string, fault: Omit<SynthFault, 'remaining'> & { remaining?: number }) {
  await mutateSynthetic(connectionId, s => { s.faults.push({ remaining: 1, ...fault }) })
}

function toGql(s: SynthState, p: SynthProduct, v: SynthVariant): GqlVariant {
  const pubs = s.publications ?? []
  const published = p.publishedOn ?? []
  const onlineStore = pubs.find(x => x.title === 'Online Store')
  const dup = v.sku ? s.products.flatMap(x => x.variants).filter(x => x.id !== v.id && x.sku === v.sku).length : 0
  return {
    id: v.id, title: v.title, sku: v.sku, inventoryPolicy: v.inventoryPolicy,
    price: v.price ?? '0.00', compareAtPrice: v.compareAtPrice ?? null, barcodes: { nodes: (v.barcodes ?? []).map(value => ({ value })) },
    sellingPlanGroupsCount: { count: v.sellingPlanGroupsCount },
    product: { id: p.id, title: p.title, handle: p.handle, status: p.status, tags: p.tags, isGiftCard: p.isGiftCard, requiresSellingPlan: p.requiresSellingPlan, sellingPlanGroupsCount: { count: p.sellingPlanGroupsCount }, updatedAt: p.updatedAt,
      onlineStoreUrl: onlineStore && published.includes(onlineStore.id) && p.status === 'ACTIVE' ? `https://${s.shop.myshopifyDomain}/products/${p.handle}` : null,
      resourcePublicationsV2: { nodes: pubs.map(x => {
        const sch = (p.scheduled ?? []).find(y => y.publicationId === x.id)
        return { publication: { id: x.id }, isPublished: published.includes(x.id) || Boolean(sch), publishDate: sch?.publishDate ?? null }
      }) } },
    inventoryItem: {
      id: v.inventoryItemId, tracked: v.tracked, duplicateSkuCount: dup,
      inventoryLevels: {
        pageInfo: { hasNextPage: false },
        nodes: v.levels.map(l => ({
          location: { id: l.locationId, name: s.locations.find(x => x.id === l.locationId)?.name ?? l.locationId },
          quantities: [{ name: 'available', quantity: l.available }, { name: 'on_hand', quantity: l.onHand }, { name: 'committed', quantity: l.committed }],
        })),
      },
    },
  }
}

function takeFault(s: SynthState, op: string): SynthFault | null {
  const f = s.faults.find(x => x.op === op && x.remaining > 0)
  if (!f) return null
  f.remaining--
  s.faults = s.faults.filter(x => x.remaining > 0)
  return f
}

const COST = (requested: number) => ({ cost: { requestedQueryCost: requested, actualQueryCost: requested, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 } } })
const THROTTLED = { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: COST(0) }

/** Handle one GraphQL request against a state object. Returns the JSON body; may throw SyntheticNetworkError. */
export function handleSynthetic(s: SynthState, body: { operationName?: string; variables?: Record<string, unknown> }, now = new Date()): { json: unknown; changed: boolean } {
  const op = body.operationName ?? ''
  const vars = body.variables ?? {}
  const fault = takeFault(s, op)
  if (fault?.mode === 'throttle_once') return { json: THROTTLED, changed: true }
  if (fault?.mode === 'read_error') throw new SyntheticNetworkError('connection reset (synthetic)')

  const all = s.products.flatMap(p => p.variants.map(v => ({ p, v })))
  switch (op) {
    case 'DeploiShop':
      return { json: { data: { shop: s.shop }, extensions: COST(1) }, changed: Boolean(fault) }
    case 'DeploiVariants': {
      const first = Math.min(Number(vars.first ?? 50), 250)
      const sorted = [...all].sort((a, b) => (a.v.id < b.v.id ? -1 : 1))
      const start = vars.after ? sorted.findIndex(x => x.v.id === Buffer.from(String(vars.after), 'base64').toString()) + 1 : 0
      const page = sorted.slice(start, start + first)
      const last = page[page.length - 1]
      return {
        json: { data: { productVariants: { pageInfo: { hasNextPage: start + first < sorted.length, endCursor: last ? Buffer.from(last.v.id).toString('base64') : null }, nodes: page.map(x => toGql(s, x.p, x.v)) } }, extensions: COST(first) },
        changed: Boolean(fault),
      }
    }
    case 'DeploiNodes': {
      const ids = (vars.ids as string[]) ?? []
      const nodes = ids.map(id => {
        const hit = all.find(x => x.v.id === id)
        if (hit) return { __typename: 'ProductVariant', ...toGql(s, hit.p, hit.v) }
        const p = s.products.find(x => x.id === id)
        if (p) return { __typename: 'Product', id: p.id, variants: { nodes: p.variants.map(v => toGql(s, p, v)) } }
        const item = all.find(x => x.v.inventoryItemId === id)
        if (item) return { __typename: 'InventoryItem', id, variants: { nodes: [toGql(s, item.p, item.v)] } }
        return null
      })
      return { json: { data: { nodes }, extensions: COST(ids.length) }, changed: Boolean(fault) }
    }
    case 'DeploiSetInventoryPolicy': {
      const productId = String(vars.productId ?? '')
      const inputs = (vars.variants as { id: string; inventoryPolicy?: string }[]) ?? []
      const p = s.products.find(x => x.id === productId)
      if (fault?.mode === 'user_error') return { json: { data: { productVariantsBulkUpdate: { productVariants: null, userErrors: [{ field: ['variants', '0', 'inventoryPolicy'], message: 'Inventory policy could not be updated (synthetic refusal)', code: 'INVALID' }] } }, extensions: COST(10) }, changed: true }
      if (!p) return { json: { data: { productVariantsBulkUpdate: { productVariants: null, userErrors: [{ field: ['productId'], message: 'Product does not exist', code: 'PRODUCT_DOES_NOT_EXIST' }] } }, extensions: COST(10) }, changed: Boolean(fault) }
      const errors: { field: string[]; message: string; code: string }[] = []
      inputs.forEach((inp, i) => {
        const v = p.variants.find(x => x.id === inp.id)
        if (!v) errors.push({ field: ['variants', String(i), 'id'], message: 'Product variant does not exist', code: 'PRODUCT_VARIANT_DOES_NOT_EXIST' })
        else if (inp.inventoryPolicy && !['CONTINUE', 'DENY'].includes(inp.inventoryPolicy)) errors.push({ field: ['variants', String(i), 'inventoryPolicy'], message: 'Invalid inventory policy', code: 'INVALID' })
      })
      if (errors.length) return { json: { data: { productVariantsBulkUpdate: { productVariants: null, userErrors: errors } }, extensions: COST(10) }, changed: Boolean(fault) }
      if (fault?.mode === 'lost_response_not_applied') throw new SyntheticNetworkError('response lost before the write (synthetic)')
      const stick = fault?.mode !== 'write_does_not_stick'
      for (const inp of inputs) {
        const v = p.variants.find(x => x.id === inp.id)!
        if (inp.inventoryPolicy && stick) v.inventoryPolicy = inp.inventoryPolicy as 'CONTINUE' | 'DENY'
      }
      p.updatedAt = now.toISOString()
      s.writeLog.push({ at: now.toISOString(), op, variantIds: inputs.map(i => i.id), inventoryPolicy: String(inputs[0]?.inventoryPolicy ?? '') })
      if (fault?.mode === 'lost_response_applied') throw new SyntheticNetworkError('response lost after the write (synthetic)')
      return {
        json: { data: { productVariantsBulkUpdate: { productVariants: inputs.map(i => ({ id: i.id, inventoryPolicy: i.inventoryPolicy })), userErrors: [] } }, extensions: COST(10) },
        changed: true,
      }
    }
    case 'DeploiFindVariants':
    case 'DeploiFindByHandle': {
      const q = String(vars.query ?? '')
      const terms = [...q.matchAll(/(sku|barcode|handle):'((?:[^'\\]|\\.)*)'/g)].map(m => ({ k: m[1], v: m[2].replace(/\\(.)/g, '$1').toLowerCase() }))
      const hit = all.filter(x => terms.some(t => (t.k === 'sku' && (x.v.sku ?? '').toLowerCase() === t.v) || (t.k === 'barcode' && (x.v.barcodes ?? []).some(b => b.toLowerCase() === t.v)) || (t.k === 'handle' && x.p.handle.toLowerCase() === t.v)))
      if (op === 'DeploiFindByHandle') {
        const products = [...new Set(hit.map(x => x.p))]
        return { json: { data: { products: { nodes: products.map(p => ({ variants: { nodes: p.variants.map(v => toGql(s, p, v)) } })) } }, extensions: COST(20) }, changed: Boolean(fault) }
      }
      return { json: { data: { productVariants: { nodes: hit.slice(0, 50).map(x => toGql(s, x.p, x.v)) } }, extensions: COST(20) }, changed: Boolean(fault) }
    }
    case 'DeploiPublications':
      return { json: { data: { shop: { currencyCode: s.shop.currencyCode }, publications: { nodes: (s.publications ?? []).map(p => ({ id: p.id, supportsFuturePublishing: p.title === 'Online Store', catalog: { __typename: 'AppCatalog', id: p.id.replace('Publication', 'AppCatalog'), title: p.title, status: 'ACTIVE' } })) } }, extensions: COST(5) }, changed: Boolean(fault) }
    case 'DeploiPublish':
    case 'DeploiUnpublish': {
      const p = s.products.find(x => x.id === String(vars.id ?? ''))
      const input = (vars.input as { publicationId: string }[]) ?? []
      const key = op === 'DeploiPublish' ? 'publishablePublish' : 'publishableUnpublish'
      if (fault?.mode === 'user_error') return { json: { data: { [key]: { userErrors: [{ field: ['input'], message: 'Publication could not be changed (synthetic refusal)' }] } }, extensions: COST(10) }, changed: true }
      if (!p) return { json: { data: { [key]: { userErrors: [{ field: ['id'], message: 'Product does not exist' }] } }, extensions: COST(10) }, changed: Boolean(fault) }
      const known = new Set((s.publications ?? []).map(x => x.id))
      const bad = input.find(i => !known.has(i.publicationId))
      if (bad) return { json: { data: { [key]: { userErrors: [{ field: ['input', '0', 'publicationId'], message: 'Publication does not exist' }] } }, extensions: COST(10) }, changed: Boolean(fault) }
      if (fault?.mode === 'lost_response_not_applied') throw new SyntheticNetworkError('response lost before the write (synthetic)')
      if (fault?.mode !== 'write_does_not_stick') {
        const set = new Set(p.publishedOn ?? [])
        for (const i of input) { if (op === 'DeploiPublish') set.add(i.publicationId); else set.delete(i.publicationId) }
        p.publishedOn = [...set]
      }
      p.updatedAt = now.toISOString()
      s.writeLog.push({ at: now.toISOString(), op, variantIds: [p.id], inventoryPolicy: '' })
      if (fault?.mode === 'lost_response_applied') throw new SyntheticNetworkError('response lost after the write (synthetic)')
      return { json: { data: { [key]: { userErrors: [] } }, extensions: COST(10) }, changed: true }
    }
    case 'DeploiUpdateVariant': {
      const productId = String(vars.productId ?? '')
      const inputs = (vars.variants as { id: string; price?: string; compareAtPrice?: string | null; inventoryItem?: { sku?: string } }[]) ?? []
      const p = s.products.find(x => x.id === productId)
      if (fault?.mode === 'user_error') return { json: { data: { productVariantsBulkUpdate: { productVariants: null, userErrors: [{ field: ['variants', '0'], message: 'Variant could not be updated (synthetic refusal)', code: 'INVALID' }] } }, extensions: COST(10) }, changed: true }
      if (!p) return { json: { data: { productVariantsBulkUpdate: { productVariants: null, userErrors: [{ field: ['productId'], message: 'Product does not exist', code: 'PRODUCT_DOES_NOT_EXIST' }] } }, extensions: COST(10) }, changed: Boolean(fault) }
      const errors: { field: string[]; message: string; code: string }[] = []
      inputs.forEach((inp, i) => {
        const v = p.variants.find(x => x.id === inp.id)
        if (!v) errors.push({ field: ['variants', String(i), 'id'], message: 'Product variant does not exist', code: 'PRODUCT_VARIANT_DOES_NOT_EXIST' })
        if (inp.price !== undefined && !/^\d+(\.\d{1,2})?$/.test(String(inp.price))) errors.push({ field: ['variants', String(i), 'price'], message: 'Price is invalid', code: 'INVALID' })
        if (inp.inventoryItem?.sku !== undefined && String(inp.inventoryItem.sku).length > 255) errors.push({ field: ['variants', String(i), 'inventoryItem', 'sku'], message: 'SKU is too long', code: 'TOO_LONG' })
      })
      if (errors.length) return { json: { data: { productVariantsBulkUpdate: { productVariants: null, userErrors: errors } }, extensions: COST(10) }, changed: Boolean(fault) }
      if (fault?.mode === 'lost_response_not_applied') throw new SyntheticNetworkError('response lost before the write (synthetic)')
      if (fault?.mode !== 'write_does_not_stick') for (const inp of inputs) {
        const v = p.variants.find(x => x.id === inp.id)!
        if (inp.price !== undefined) v.price = String(inp.price)
        if (inp.compareAtPrice !== undefined) v.compareAtPrice = inp.compareAtPrice
        if (inp.inventoryItem?.sku !== undefined) v.sku = inp.inventoryItem.sku
      }
      p.updatedAt = now.toISOString()
      s.writeLog.push({ at: now.toISOString(), op, variantIds: inputs.map(i => i.id), inventoryPolicy: '' })
      if (fault?.mode === 'lost_response_applied') throw new SyntheticNetworkError('response lost after the write (synthetic)')
      return { json: { data: { productVariantsBulkUpdate: { productVariants: inputs.map(i => { const v = p.variants.find(x => x.id === i.id)!; return { id: v.id, price: v.price, compareAtPrice: v.compareAtPrice ?? null, sku: v.sku } }), userErrors: [] } }, extensions: COST(10) }, changed: true }
    }
    case 'DeploiPriceOverrides': {
      const m = /variant_id:(\d+)/.exec(String(vars.query ?? ''))
      const vid = m ? `gid://shopify/ProductVariant/${m[1]}` : ''
      const has = (s.priceListOverrides ?? []).includes(vid)
      return { json: { data: { priceLists: { nodes: has ? [{ id: 'gid://shopify/PriceList/1', name: 'Wholesale (synthetic)', currency: s.shop.currencyCode, prices: { nodes: [{ price: { amount: '1.00', currencyCode: s.shop.currencyCode } }] } }] : [] } }, extensions: COST(10) }, changed: Boolean(fault) }
    }
    case 'DeploiAccessScopes':
      return { json: { data: { currentAppInstallation: { accessScopes: (s.accessScopes ?? [...REQUIRED_SCOPES, ...OPTIONAL_SCOPES]).map(handle => ({ handle })) } }, extensions: COST(1) }, changed: Boolean(fault) }
    case 'DeploiActiveSubscriptions':
      return { json: { data: { currentAppInstallation: { activeSubscriptions: s.subscriptions.filter(x => x.status === 'ACTIVE') } }, extensions: COST(1) }, changed: Boolean(fault) }
    case 'DeploiCreateSubscription': {
      const id = `gid://shopify/AppSubscription/${900000 + s.subscriptions.length + 1}`
      s.subscriptions.push({ id, name: String(vars.name), status: 'PENDING', test: Boolean(vars.test), trialDays: Number(vars.trialDays ?? 0), currentPeriodEnd: null, createdAt: now.toISOString() })
      return { json: { data: { appSubscriptionCreate: { appSubscription: { id, status: 'PENDING' }, confirmationUrl: `https://${s.shop.myshopifyDomain}/admin/charges/synthetic/${id.split('/').pop()}/confirm`, userErrors: [] } }, extensions: COST(10) }, changed: true }
    }
    default:
      return { json: { errors: [{ message: `synthetic store does not implement ${op || 'anonymous operations'}` }] }, changed: Boolean(fault) }
  }
}

/** Transport bound to one synthetic connection: each request runs in its own locked transaction. */
export function syntheticTransport(connectionId: string) {
  return async (body: { query: string; operationName: string; variables?: Record<string, unknown> }) => {
    let networkError: Error | null = null
    const json = await admin(async db => {
      const r = await db.one<{ state: SynthState }>('select state from synthetic_store_state where connection_id = $1 for update', [connectionId])
      if (!r) throw new Error('no synthetic store for this connection')
      let out: { json: unknown; changed: boolean }
      try { out = handleSynthetic(r.state, body) } catch (e) {
        if (!(e instanceof SyntheticNetworkError)) throw e
        networkError = e
        out = { json: null, changed: true }
      }
      if (out.changed) await db.query('update synthetic_store_state set state = $2, updated_at = now() where connection_id = $1', [connectionId, JSON.stringify(r.state)])
      return out.json
    })
    if (networkError) throw networkError
    return { status: 200, json }
  }
}

// ---------------------------------------------------------------- commerce scenarios
const CP = (n: number) => `gid://shopify/Product/${n}`
const CV = (n: number) => `gid://shopify/ProductVariant/${n}`
const CI = (n: number) => `gid://shopify/InventoryItem/${n}`
const CO = (n: number) => `gid://shopify/Order/${n}`
const CL = (n: number) => `gid://shopify/LineItem/${n}`
const CDAY = 864e5
const ago = (now: Date, days: number) => new Date(now.getTime() - days * CDAY).toISOString()
export const COMMERCE_DOMAIN = 'fernhill-commerce-demo.myshopify.com'
export const COMMERCE_IDS = {
  location: 'gid://shopify/Location/301',
  onlineStore: 'gid://shopify/Publication/601',
  featured: 'gid://shopify/Collection/801',
  summerEdit: 'gid://shopify/Collection/802',
  /** the best seller (most units in the last 30 days) */
  throw: { product: CP(3001), variant: CV(4001) },
  mug: { product: CP(3002), variant: CV(4002) },
  lantern: { product: CP(3003), variant: CV(4003) },
  apron: { product: CP(3004), variant: CV(4004) },
  candle: { product: CP(3005), variant: CV(4005) },
  basket: { product: CP(3006), variant: CV(4006) },
} as const

const GOOD: Record<string, { title: string; vendor: string; type: string; material: string; price: string; stock: number; desc: string }> = {
  [CP(3001)]: { title: 'Wool Throw Blanket', vendor: 'Highland Mills', type: 'Blankets', material: '100% lambswool', price: '89.00', stock: 40, desc: 'A warm lambswool throw woven at Highland Mills. Sized for a sofa or the end of a bed, with fringed edges and a soft brushed finish that gets better with use.' },
  [CP(3002)]: { title: 'Stoneware Mug', vendor: 'Clay & Kiln', type: 'Mugs', material: 'Glazed stoneware', price: '24.00', stock: 60, desc: 'A hand-glazed stoneware mug from Clay & Kiln that holds a generous cup of coffee or tea. Dishwasher and microwave safe, with a comfortable wide handle.' },
  [CP(3003)]: { title: 'Brass Lantern', vendor: 'Lumen Works', type: 'Lighting', material: 'Solid brass', price: '65.00', stock: 25, desc: 'A solid brass lantern from Lumen Works with a glass chimney, for a pillar candle or a battery light. Hangs from its loop handle or stands on a table.' },
  [CP(3004)]: { title: 'Canvas Apron', vendor: 'Fernhill Workshop', type: 'Aprons', material: 'Waxed cotton canvas', price: '38.00', stock: 30, desc: 'A waxed cotton canvas apron made in the Fernhill Workshop, with two deep front pockets, leather neck strap and long cross-back ties for an easy fit.' },
  [CP(3005)]: { title: 'Fig Leaf Candle', vendor: 'Lumen Works', type: 'Candles', material: 'Soy wax', price: '28.00', stock: 45, desc: 'A soy wax candle from Lumen Works scented with fig leaf and cedar, poured into a reusable amber glass jar. Burns for around forty hours.' },
  [CP(3006)]: { title: 'Seagrass Basket', vendor: 'Fernhill Workshop', type: 'Storage', material: 'Woven seagrass', price: '42.00', stock: 18, desc: 'A woven seagrass basket with rope handles, made in the Fernhill Workshop. Holds blankets, logs or laundry and folds flat when it is not needed.' },
}

/** A synthetic store with nothing wrong: every scenario seeder adds one problem to this. */
export function commerceQuietState(now = new Date()): SynthState {
  const ids = Object.keys(GOOD)
  const products: SynthProduct[] = ids.map((id, i) => {
    const g = GOOD[id], n = 4001 + i
    return { id, title: g.title, handle: g.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), status: 'ACTIVE', tags: [g.type.toLowerCase()], isGiftCard: false, requiresSellingPlan: false, sellingPlanGroupsCount: 0, updatedAt: ago(now, 30), publishedOn: [COMMERCE_IDS.onlineStore],
      variants: [{ id: CV(n), title: 'Default Title', sku: `FH-${g.type.slice(0, 3).toUpperCase()}-${n}`, inventoryPolicy: 'DENY', sellingPlanGroupsCount: 0, inventoryItemId: CI(5001 + i), tracked: true, price: g.price, barcodes: [`0${n}00012345`], levels: [{ locationId: COMMERCE_IDS.location, available: g.stock, onHand: g.stock, committed: 0 }] }] }
  })
  const info: Record<string, SynthProductInfo> = Object.fromEntries(ids.map(id => [id, { vendor: GOOD[id].vendor, productType: GOOD[id].type, material: GOOD[id].material, descriptionHtml: `<p>${GOOD[id].desc}</p>`, seoDescription: GOOD[id].desc.slice(0, 150), images: [{ alt: GOOD[id].title }, { alt: `${GOOD[id].title}, detail` }] }]))
  const names = ['Ava', 'Ben', 'Chloe', 'Dev', 'Esme', 'Finn', 'Grace', 'Hugo', 'Iris', 'Jude']
  // sales history: the throw sells most, then the mug; every order shipped and was delivered
  const plan: [string, number, number][] = [[CP(3001), 3, 20], [CP(3001), 2, 15], [CP(3002), 2, 12], [CP(3001), 2, 10], [CP(3003), 1, 9], [CP(3002), 1, 8], [CP(3001), 3, 6], [CP(3005), 1, 5], [CP(3004), 1, 4], [CP(3001), 2, 3]]
  const orders: SynthOrder[] = plan.map(([pid, qty, days], i) => {
    const p = products.find(x => x.id === pid)!
    const shipped = ago(now, days - 1), delivered = ago(now, Math.max(0, days - 3))
    return { id: CO(7101 + i), name: `#${1101 + i}`, createdAt: ago(now, days), email: `${names[i].toLowerCase()}@shopper.example`, customerFirstName: names[i], cancelledAt: null, fulfillmentStatus: 'FULFILLED',
      lineItems: [{ id: CL(7601 + i), productId: pid, variantId: p.variants[0].id, title: p.title, quantity: qty, price: p.variants[0].price ?? '0.00' }],
      fulfillments: [{ id: `gid://shopify/Fulfillment/${7301 + i}`, createdAt: shipped, trackingNumber: `FH${900100 + i}`, trackingUrl: `https://tracking.example/FH${900100 + i}`, carrier: 'Example Post', lastEvent: 'Delivered', lastEventAt: delivered, deliveredAt: delivered }] }
  })
  const gross = (o: SynthOrder) => o.lineItems.reduce((a, l) => a + Number(l.price) * l.quantity, 0)
  const payoutOf = (id: number, list: SynthOrder[], days: number): SynthPayout => {
    const g = list.reduce((a, o) => a + gross(o), 0), fees = g * 0.029 + list.length * 0.3
    return { id: `gid://shopify/ShopifyPaymentsPayout/${id}`, issuedAt: ago(now, days), status: 'PAID', gross: g.toFixed(2), fees: fees.toFixed(2), refunds: '0.00', adjustments: '0.00', net: (g - Number(fees.toFixed(2))).toFixed(2), orderIds: list.map(o => o.id) }
  }
  return {
    shop: { name: 'Fernhill Home (synthetic)', myshopifyDomain: COMMERCE_DOMAIN, ianaTimezone: 'Europe/London', currencyCode: 'USD' },
    locations: [{ id: COMMERCE_IDS.location, name: 'Warehouse' }],
    publications: [{ id: COMMERCE_IDS.onlineStore, title: 'Online Store' }],
    products, faults: [], writeLog: [], subscriptions: [],
    commerce: {
      info, orders, returns: [], refunds: [],
      collections: [
        { id: COMMERCE_IDS.featured, title: 'Featured', handle: 'featured', promoted: true, smart: false, productIds: [CP(3001), CP(3002), CP(3003)] },
        { id: COMMERCE_IDS.summerEdit, title: 'All products', handle: 'all', promoted: false, smart: true, productIds: ids },
      ],
      discounts: [{ id: 'gid://shopify/DiscountCodeNode/9101', code: 'WELCOME10', title: 'Welcome 10%', percent: 10, status: 'ACTIVE', startsAt: ago(now, 60), endsAt: null, productIds: [] }],
      announcement: 'Free delivery on orders over $75',
      payouts: [payoutOf(9201, orders.slice(0, 5), 7), payoutOf(9202, orders.slice(5), 1)],
      mailbox: [], outbox: [],
      suppliers: [
        { vendor: 'Highland Mills', name: 'Highland Mills', email: 'orders@highland-mills.example', leadTimeDays: 10 },
        { vendor: 'Clay & Kiln', name: 'Clay & Kiln', email: 'trade@clayandkiln.example', leadTimeDays: 14 },
        { vendor: 'Lumen Works', name: 'Lumen Works', email: 'wholesale@lumenworks.example', leadTimeDays: 7 },
      ],
      crew: [{ id: 'crew-packer-1', name: 'Sam (packing)', role: 'packer', address: 'sam.packing@fernhill.example' }],
      policy: { returnWindowDays: 30, promisedDispatchDays: 2, feeRatePct: 2.9, feeFixed: 0.3 },
    },
  }
}

export const COMMERCE_SCENARIOS = [
  'best_seller_low_stock', 'selling_past_zero', 'restock_no_reply', 'stuck_order', 'tracking_stalled', 'return_in_policy', 'return_damaged', 'return_outside_policy',
  'weak_description', 'thin_facts_description', 'promoted_out_of_stock', 'expired_discount_advertised', 'wismo_email', 'wismo_email_unknown_order', 'payout_mismatch', 'missing_payout', 'ai_visibility_gap',
] as const
export type CommerceScenario = (typeof COMMERCE_SCENARIOS)[number]

const deliveredOrder = (s: SynthState, n: number, now: Date, daysSinceDelivery: number, name: string, product = COMMERCE_IDS.mug): SynthOrder => {
  const p = s.products.find(x => x.id === product.product)!
  const delivered = ago(now, daysSinceDelivery)
  const o: SynthOrder = { id: CO(n), name: `#${n - 6000}`, createdAt: ago(now, daysSinceDelivery + 4), email: `${name.toLowerCase()}@shopper.example`, customerFirstName: name, cancelledAt: null, fulfillmentStatus: 'FULFILLED',
    lineItems: [{ id: CL(n + 500), productId: p.id, variantId: p.variants[0].id, title: p.title, quantity: 1, price: p.variants[0].price ?? '0.00' }],
    fulfillments: [{ id: `gid://shopify/Fulfillment/${n + 200}`, createdAt: ago(now, daysSinceDelivery + 3), trackingNumber: `FH${n}`, trackingUrl: `https://tracking.example/FH${n}`, carrier: 'Example Post', lastEvent: 'Delivered', lastEventAt: delivered, deliveredAt: delivered }] }
  s.commerce!.orders.push(o)
  return o
}

/** Put one scenario's problem into a synthetic commerce store (usually commerceQuietState). */
export function seedCommerceScenario(s: SynthState, scenario: CommerceScenario, now = new Date()): SynthState {
  const c = s.commerce
  if (!c) throw new Error('not a commerce synthetic store: start from commerceQuietState()')
  const product = (id: string) => s.products.find(p => p.id === id)!
  const setStock = (id: string, n: number) => { for (const l of product(id).variants[0].levels) { l.available = n; l.onHand = Math.max(0, n) } }
  switch (scenario) {
    case 'best_seller_low_stock': setStock(COMMERCE_IDS.throw.product, 3); break
    case 'selling_past_zero': setStock(COMMERCE_IDS.basket.product, 0); product(COMMERCE_IDS.basket.product).variants[0].inventoryPolicy = 'CONTINUE'; break
    case 'restock_no_reply':
      c.outbox.push({ id: 'sent-restock-1', sentAt: ago(now, 4), to: 'trade@clayandkiln.example', subject: 'Restock request: Stoneware Mug', text: 'Hello,\n\nCould you confirm availability and lead time for: Stoneware Mug (SKU FH-MUG-4002), 48 units.\n\nThanks,\nFernhill Home', inReplyTo: null, agentKey: 'supplier_chaser' })
      break
    case 'stuck_order': {
      const p = product(COMMERCE_IDS.lantern.product)
      c.orders.push({ id: CO(7201), name: '#1201', createdAt: ago(now, 5), email: 'kit@shopper.example', customerFirstName: 'Kit', cancelledAt: null, fulfillmentStatus: 'UNFULFILLED',
        lineItems: [{ id: CL(7701), productId: p.id, variantId: p.variants[0].id, title: p.title, quantity: 1, price: p.variants[0].price ?? '0.00' }], fulfillments: [] })
      break
    }
    case 'tracking_stalled': {
      const o = deliveredOrder(s, 7202, now, 0, 'Lena', COMMERCE_IDS.apron)
      Object.assign(o.fulfillments[0], { createdAt: ago(now, 9), lastEvent: 'In transit', lastEventAt: ago(now, 6), deliveredAt: null })
      o.createdAt = ago(now, 10)
      break
    }
    case 'return_in_policy': { const o = deliveredOrder(s, 7203, now, 6, 'Mia'); c.returns.push({ id: 'gid://shopify/Return/8201', orderId: o.id, status: 'REQUESTED', requestedAt: ago(now, 0), lineItemId: o.lineItems[0].id, quantity: 1, reason: 'SIZE_TOO_SMALL', note: 'Smaller than I expected, unused and in the box' }); break }
    case 'return_damaged': { const o = deliveredOrder(s, 7204, now, 2, 'Noah'); c.returns.push({ id: 'gid://shopify/Return/8202', orderId: o.id, status: 'REQUESTED', requestedAt: ago(now, 0), lineItemId: o.lineItems[0].id, quantity: 1, reason: 'DEFECTIVE', note: 'Arrived damaged, the handle is cracked' }); break }
    case 'return_outside_policy': { const o = deliveredOrder(s, 7205, now, 45, 'Olive'); c.returns.push({ id: 'gid://shopify/Return/8203', orderId: o.id, status: 'REQUESTED', requestedAt: ago(now, 0), lineItemId: o.lineItems[0].id, quantity: 1, reason: 'UNWANTED', note: 'Changed my mind' }); break }
    case 'weak_description': c.info[COMMERCE_IDS.candle.product].descriptionHtml = '<p>Nice candle.</p>'; break
    case 'thin_facts_description': {
      // a product with no facts to write from: no vendor, type, material or tags
      s.products.push({ id: CP(3099), title: 'Mystery Item', handle: 'mystery-item', status: 'ACTIVE', tags: [], isGiftCard: false, requiresSellingPlan: false, sellingPlanGroupsCount: 0, updatedAt: ago(now, 2), publishedOn: [COMMERCE_IDS.onlineStore],
        variants: [{ id: CV(4099), title: 'Default Title', sku: 'FH-MYS-4099', inventoryPolicy: 'DENY', sellingPlanGroupsCount: 0, inventoryItemId: CI(5099), tracked: true, price: '10.00', barcodes: ['04099000123'], levels: [{ locationId: COMMERCE_IDS.location, available: 10, onHand: 10, committed: 0 }] }] })
      c.info[CP(3099)] = { descriptionHtml: '', seoDescription: 'Mystery Item', images: [{ alt: 'Mystery Item' }] }
      break
    }
    case 'promoted_out_of_stock': setStock(COMMERCE_IDS.lantern.product, 0); break
    case 'expired_discount_advertised':
      c.discounts.push({ id: 'gid://shopify/DiscountCodeNode/9102', code: 'SUMMER20', title: 'Summer 20%', percent: 20, status: 'ACTIVE', startsAt: ago(now, 30), endsAt: ago(now, 2), productIds: [] })
      c.announcement = 'Summer sale: use SUMMER20 for 20% off everything'
      break
    case 'wismo_email': c.mailbox.push({ id: 'mail-wismo-1', receivedAt: ago(now, 0), from: 'ben@shopper.example', to: 'hello@fernhill.example', subject: 'Where is my order?', text: 'Hi, where is my order #1102? It has been a while. Ben', inReplyTo: null }); break
    case 'wismo_email_unknown_order': c.mailbox.push({ id: 'mail-wismo-2', receivedAt: ago(now, 0), from: 'stranger@shopper.example', to: 'hello@fernhill.example', subject: 'Order status', text: 'Has my order shipped yet?', inReplyTo: null }); break
    case 'payout_mismatch': {
      const p = c.payouts[0]
      p.fees = (Number(p.fees) + 9.4).toFixed(2)
      p.net = (Number(p.gross) - Number(p.fees)).toFixed(2)
      break
    }
    case 'missing_payout': c.payouts[1].status = 'FAILED'; break
    case 'ai_visibility_gap': Object.assign(c.info[COMMERCE_IDS.apron.product], { seoDescription: null, images: [{ alt: null }, { alt: null }] }); break
  }
  return s
}
