/**
 * Shopify connector: reads variants (with inventory levels, prices, SKUs, barcodes and product
 * publications) and performs the four supported corrections. Each write is one field on one
 * variant or product, so every approved change is written and audited alone. The connector
 * enforces the writable fields it is given, independently of the engine.
 */
import type { ApplyResult, Connector, ConnectionRow, Correction, LookupKeys } from '../../engine/types'
import { shopifyGraphql, ShopifyApiError } from './client'
import { Q_NODES, Q_VARIANTS, M_SET_INVENTORY_POLICY, Q_FIND_VARIANTS, Q_FIND_BY_HANDLE, Q_PUBLICATIONS, M_PUBLISH, M_UNPUBLISH, M_UPDATE_VARIANT, Q_PRICE_OVERRIDES } from './queries'
import { normalizeVariant, type GqlVariant } from './normalize'
import { ACTION_SCOPES, READ_SCOPES } from './config'
import { SET_POLICY_ACTION } from './checks'
import { PUBLISH_ACTION, UNPUBLISH_ACTION, SET_PRICE_ACTION, SET_COMPARE_AT_ACTION, SET_SKU_ACTION } from './listing-checks'
import type { ShopifyVariantRecord } from './types'

const PAGE = 25
const isVariantId = (id: string) => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id)
const isProductId = (id: string) => /^gid:\/\/shopify\/Product\/\d+$/.test(id)
const isInventoryItemId = (id: string) => /^gid:\/\/shopify\/InventoryItem\/\d+$/.test(id)
const isPublicationId = (id: string) => /^gid:\/\/shopify\/Publication\/\d+$/.test(id)
const isMoney = (v: unknown) => typeof v === 'string' && /^\d{1,9}\.\d{2}$/.test(v)

/** The record field each action writes; a correction outside `allowedFields` is refused before any request. */
export const ACTION_WRITES: Record<string, string> = {
  [SET_POLICY_ACTION]: 'inventoryPolicy',
  [PUBLISH_ACTION]: 'published',
  [UNPUBLISH_ACTION]: 'published',
  [SET_PRICE_ACTION]: 'price',
  [SET_COMPARE_AT_ACTION]: 'compareAtPrice',
  [SET_SKU_ACTION]: 'sku',
}

/** Shopify search syntax: quote a value and escape quotes and backslashes. */
const quote = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

type UserError = { field: string[] | null; message: string; code?: string }

function refused(request: Record<string, unknown>, error: string, blocked = true): ApplyResult {
  return { outcome: 'rejected', request, response: null, error, blocked }
}

async function send(conn: ConnectionRow, request: Record<string, unknown>, doc: { query: string; operationName: string; variables: Record<string, unknown> }, pick: (d: Record<string, unknown>) => { userErrors?: UserError[] | null } & Record<string, unknown>): Promise<ApplyResult> {
  try {
    const data = await shopifyGraphql<Record<string, unknown>>(conn, doc, { mutation: true })
    const r = pick(data)
    if (r.userErrors?.length) return { outcome: 'rejected', request, response: { userErrors: r.userErrors }, error: r.userErrors.map(e => e.message).join('; ') }
    return { outcome: 'applied', request, response: r }
  } catch (e) {
    const err = e as ShopifyApiError
    // an auth or GraphQL validation error is a definite refusal; a lost response is not
    if (err.kind === 'auth' || err.kind === 'graphql') return { outcome: 'rejected', request, response: null, error: err.message }
    return { outcome: 'unknown', request, response: null, error: err.message }
  }
}

/** Sales channels this app can publish to, and the shop currency. Online Store is identified by the merchant, never guessed. */
export async function listPublications(conn: ConnectionRow): Promise<{ currency: string | null; publications: { id: string; title: string; supportsFuturePublishing: boolean }[] }> {
  const data = await shopifyGraphql<{ shop: { currencyCode: string }; publications: { nodes: { id: string; supportsFuturePublishing?: boolean; catalog: { title: string; status?: string } | null }[] } }>(
    conn, { query: Q_PUBLICATIONS, operationName: 'DeploiPublications', variables: {} })
  return {
    currency: data.shop?.currencyCode ?? null,
    publications: data.publications.nodes.filter(n => n.catalog && n.catalog.status !== 'ARCHIVED').map(n => ({ id: n.id, title: n.catalog!.title, supportsFuturePublishing: Boolean(n.supportsFuturePublishing) })),
  }
}

/** Fixed Markets / B2B prices for a variant. A base-price change would not reach those buyers, so the change is blocked. */
async function priceOverrides(conn: ConnectionRow, variantId: string): Promise<string[]> {
  const num = variantId.split('/').pop()
  const data = await shopifyGraphql<{ priceLists: { nodes: { name: string; prices: { nodes: unknown[] } }[] } }>(
    conn, { query: Q_PRICE_OVERRIDES, operationName: 'DeploiPriceOverrides', variables: { query: `variant_id:${num}` } })
  return data.priceLists.nodes.filter(n => n.prices.nodes.length > 0).map(n => n.name)
}

export const shopifyConnector: Connector<ShopifyVariantRecord> = {
  platform: 'shopify',
  operational: true,
  requiredScopes: { read: READ_SCOPES, actions: ACTION_SCOPES },

  async *listResources(conn: ConnectionRow) {
    let after: string | null = null
    for (let guard = 0; guard < 10000; guard++) {
      const data: { productVariants: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlVariant[] } } =
        await shopifyGraphql(conn, { query: Q_VARIANTS, operationName: 'DeploiVariants', variables: { first: PAGE, after } })
      const fetchedAt = new Date().toISOString()
      yield data.productVariants.nodes.map(v => normalizeVariant(v, fetchedAt))
      if (!data.productVariants.pageInfo.hasNextPage || !data.productVariants.pageInfo.endCursor) return
      after = data.productVariants.pageInfo.endCursor
    }
  },

  async readResources(conn, ids) {
    const wanted = ids.filter(id => isVariantId(id) || isProductId(id) || isInventoryItemId(id))
    const out = new Map<string, ShopifyVariantRecord>()
    for (let i = 0; i < wanted.length; i += 50) {
      const chunk = wanted.slice(i, i + 50)
      const data = await shopifyGraphql<{ nodes: (null | ({ __typename: 'ProductVariant' } & GqlVariant) | { __typename: 'Product' | 'InventoryItem'; id: string; variants: { nodes: GqlVariant[] } })[] }>(
        conn, { query: Q_NODES, operationName: 'DeploiNodes', variables: { ids: chunk } })
      const fetchedAt = new Date().toISOString()
      for (const n of data.nodes) {
        if (!n) continue
        if (n.__typename === 'ProductVariant') { const r = normalizeVariant(n as GqlVariant, fetchedAt); out.set(r.resourceId, r) }
        else if (n.__typename === 'Product' || n.__typename === 'InventoryItem') for (const v of n.variants.nodes) { const r = normalizeVariant(v, fetchedAt); out.set(r.resourceId, r) }
      }
    }
    return out
  },

  async findResources(conn, keys: LookupKeys) {
    const out = new Map<string, ShopifyVariantRecord>()
    const terms = [...keys.skus.map(v => `sku:${quote(v)}`), ...keys.barcodes.map(v => `barcode:${quote(v)}`)]
    for (let i = 0; i < terms.length; i += 10) {
      const data = await shopifyGraphql<{ productVariants: { nodes: GqlVariant[] } }>(conn, { query: Q_FIND_VARIANTS, operationName: 'DeploiFindVariants', variables: { query: terms.slice(i, i + 10).join(' OR ') } })
      const fetchedAt = new Date().toISOString()
      for (const v of data.productVariants.nodes) { const r = normalizeVariant(v, fetchedAt); out.set(r.resourceId, r) }
    }
    for (let i = 0; i < keys.handles.length; i += 10) {
      const data = await shopifyGraphql<{ products: { nodes: { variants: { nodes: GqlVariant[] } }[] } }>(conn, { query: Q_FIND_BY_HANDLE, operationName: 'DeploiFindByHandle', variables: { query: keys.handles.slice(i, i + 10).map(h => `handle:${quote(h)}`).join(' OR ') } })
      const fetchedAt = new Date().toISOString()
      for (const p of data.products.nodes) for (const v of p.variants.nodes) { const r = normalizeVariant(v, fetchedAt); out.set(r.resourceId, r) }
    }
    return [...out.values()]
  },

  async applyAction(conn, c: Correction, allowedFields?: string[]): Promise<ApplyResult> {
    const base = { actionKey: c.actionKey, targetId: c.targetId }
    const writes = ACTION_WRITES[c.actionKey]
    if (!writes) return refused(base, `unsupported action ${c.actionKey}`)
    if (allowedFields && !allowedFields.includes(writes)) return refused(base, `field "${writes}" is not writable under this authorization`)
    const productId = String(c.params?.productId ?? '')

    if (c.actionKey === SET_POLICY_ACTION) {
      const to = String(c.change.to)
      if (!isProductId(productId) || !isVariantId(c.targetId) || !['CONTINUE', 'DENY'].includes(to)) return refused(base, 'invalid correction parameters')
      const variables = { productId, variants: [{ id: c.targetId, inventoryPolicy: to }] }
      return send(conn, { operation: 'productVariantsBulkUpdate', variables }, { query: M_SET_INVENTORY_POLICY, operationName: 'DeploiSetInventoryPolicy', variables },
        d => d.productVariantsBulkUpdate as { userErrors: UserError[] })
    }

    if (c.actionKey === PUBLISH_ACTION || c.actionKey === UNPUBLISH_ACTION) {
      const publicationId = String(c.params?.publicationId ?? '')
      const publish = c.actionKey === PUBLISH_ACTION
      if (!isProductId(c.targetId) || !isPublicationId(publicationId) || c.change.to !== publish || c.change.field !== `published.${publicationId}`) return refused(base, 'invalid correction parameters')
      const variables = { id: c.targetId, input: [{ publicationId }] }
      const op = publish ? 'publishablePublish' : 'publishableUnpublish'
      return send(conn, { operation: op, variables }, { query: publish ? M_PUBLISH : M_UNPUBLISH, operationName: publish ? 'DeploiPublish' : 'DeploiUnpublish', variables },
        d => d[op] as { userErrors: UserError[] })
    }

    // variant field updates: price, compare-at price, SKU (one field per call)
    if (!isProductId(productId) || !isVariantId(c.targetId)) return refused(base, 'invalid correction parameters')
    let variant: Record<string, unknown>
    if (c.actionKey === SET_PRICE_ACTION || c.actionKey === SET_COMPARE_AT_ACTION) {
      // never clears a compare-at price (the effect of null on update is unverified) and never writes a malformed amount
      if (!isMoney(c.change.to)) return refused(base, 'the target price is not a valid amount')
      if (c.actionKey === SET_PRICE_ACTION) {
        let lists: string[]
        try { lists = await priceOverrides(conn, c.targetId) } catch (e) { return refused(base, `could not check Markets price lists before writing: ${(e as Error).message.slice(0, 120)}`) }
        if (lists.length) return { ...refused(base, `fixed prices exist on price list${lists.length === 1 ? '' : 's'} ${lists.map(n => `"${n}"`).join(', ')}; changing the base price would not reach those buyers, so a person must decide`), response: { priceLists: lists } }
      }
      variant = c.actionKey === SET_PRICE_ACTION ? { id: c.targetId, price: c.change.to } : { id: c.targetId, compareAtPrice: c.change.to }
    } else {
      const to = c.change.to
      if (typeof to !== 'string' || !to.trim() || to.length > 255) return refused(base, 'the target SKU is empty or too long')
      variant = { id: c.targetId, inventoryItem: { sku: to } }
    }
    const variables = { productId, variants: [variant] }
    return send(conn, { operation: 'productVariantsBulkUpdate', variables }, { query: M_UPDATE_VARIANT, operationName: 'DeploiUpdateVariant', variables },
      d => d.productVariantsBulkUpdate as { userErrors: UserError[] })
  },
}
