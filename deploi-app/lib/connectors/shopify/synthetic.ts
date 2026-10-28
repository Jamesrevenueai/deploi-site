/**
 * Synthetic Shopify store: answers this app's Admin GraphQL operations from a JSON state kept in
 * synthetic_store_state, so demos and tests exercise the real connector code path (GraphQL
 * documents, response shapes, userErrors, throttling) without touching a real merchant.
 * It is only reachable for connections flagged is_synthetic. Fault injection covers the failure
 * paths: platform refusal, lost responses, writes that do not stick, unreadable records.
 */
import { admin } from '../../db'
import type { GqlVariant } from './normalize'

export type SynthLevel = { locationId: string; available: number; onHand: number; committed: number }
export type SynthVariant = { id: string; title: string; sku: string | null; inventoryPolicy: 'CONTINUE' | 'DENY'; sellingPlanGroupsCount: number; inventoryItemId: string; tracked: boolean; levels: SynthLevel[] }
export type SynthProduct = { id: string; title: string; handle: string; status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED'; tags: string[]; isGiftCard: boolean; requiresSellingPlan: boolean; sellingPlanGroupsCount: number; updatedAt: string; variants: SynthVariant[] }
export type SynthFault = { op: string; mode: 'user_error' | 'lost_response_applied' | 'lost_response_not_applied' | 'write_does_not_stick' | 'read_error' | 'throttle_once'; remaining: number }
export type SynthState = {
  shop: { name: string; myshopifyDomain: string; ianaTimezone: string; currencyCode: string }
  locations: { id: string; name: string }[]
  products: SynthProduct[]
  faults: SynthFault[]
  writeLog: { at: string; op: string; variantIds: string[]; inventoryPolicy: string }[]
  subscriptions: { id: string; name: string; status: string; test: boolean; trialDays: number; currentPeriodEnd: string | null; createdAt: string }[]
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
  return {
    id: v.id, title: v.title, sku: v.sku, inventoryPolicy: v.inventoryPolicy,
    sellingPlanGroupsCount: { count: v.sellingPlanGroupsCount },
    product: { id: p.id, title: p.title, handle: p.handle, status: p.status, tags: p.tags, isGiftCard: p.isGiftCard, requiresSellingPlan: p.requiresSellingPlan, sellingPlanGroupsCount: { count: p.sellingPlanGroupsCount }, updatedAt: p.updatedAt },
    inventoryItem: {
      id: v.inventoryItemId, tracked: v.tracked,
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
