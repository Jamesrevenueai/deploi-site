/** Shopify connector: reads variants with inventory levels and performs the inventory-policy correction. */
import type { ApplyResult, Connector, ConnectionRow, Correction } from '../../engine/types'
import { shopifyGraphql, ShopifyApiError } from './client'
import { Q_NODES, Q_VARIANTS, M_SET_INVENTORY_POLICY } from './queries'
import { normalizeVariant, type GqlVariant } from './normalize'
import { ACTION_SCOPES, READ_SCOPES } from './config'
import { SET_POLICY_ACTION } from './checks'
import type { ShopifyVariantRecord } from './types'

const PAGE = 25
const isVariantId = (id: string) => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id)
const isProductId = (id: string) => /^gid:\/\/shopify\/Product\/\d+$/.test(id)
const isInventoryItemId = (id: string) => /^gid:\/\/shopify\/InventoryItem\/\d+$/.test(id)

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

  async applyAction(conn, c: Correction): Promise<ApplyResult> {
    if (c.actionKey !== SET_POLICY_ACTION) return { outcome: 'rejected', request: { actionKey: c.actionKey }, response: null, error: `unsupported action ${c.actionKey}` }
    const productId = String(c.params?.productId ?? '')
    const to = String(c.change.to)
    if (!isProductId(productId) || !isVariantId(c.targetId) || !['CONTINUE', 'DENY'].includes(to)) {
      return { outcome: 'rejected', request: { actionKey: c.actionKey }, response: null, error: 'invalid correction parameters' }
    }
    const variables = { productId, variants: [{ id: c.targetId, inventoryPolicy: to }] }
    const request = { operation: 'productVariantsBulkUpdate', variables }
    try {
      const data = await shopifyGraphql<{ productVariantsBulkUpdate: { productVariants: { id: string; inventoryPolicy: string }[] | null; userErrors: { field: string[] | null; message: string; code?: string }[] } }>(
        conn, { query: M_SET_INVENTORY_POLICY, operationName: 'DeploiSetInventoryPolicy', variables }, { mutation: true })
      const r = data.productVariantsBulkUpdate
      if (r.userErrors?.length) return { outcome: 'rejected', request, response: { userErrors: r.userErrors }, error: r.userErrors.map(e => e.message).join('; ') }
      return { outcome: 'applied', request, response: { productVariants: r.productVariants } }
    } catch (e) {
      const err = e as ShopifyApiError
      // an auth or GraphQL validation error is a definite refusal; a lost response is not
      if (err.kind === 'auth' || err.kind === 'graphql') return { outcome: 'rejected', request, response: null, error: err.message }
      return { outcome: 'unknown', request, response: null, error: err.message }
    }
  },
}
