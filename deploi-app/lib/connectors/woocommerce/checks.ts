/**
 * WooCommerce stock checks, from docs/platform-research/woocommerce.md.
 * Record = one product (simple, variable parent, grouped, external) or one variation. Stock checks act only
 * on the stock-owning object (manage_stock true): variations with manage_stock "parent" are represented by
 * their parent. Listing checks (price, SKU, publication) are in listing-checks.ts.
 */
import type { CheckDef, Finding, ResourceRecord } from '../../engine/types'

export type WooStockRecord = ResourceRecord & {
  resourceType: 'woo_stock_object'
  productId: number
  variationId: number | null
  name: string
  sku: string | null
  type: string
  status: 'publish' | 'draft' | 'pending' | 'private' | string
  tags: string[]
  manageStock: boolean | 'parent'
  stockQuantity: number | null
  stockStatus: 'instock' | 'outofstock' | 'onbackorder' | string
  backorders: 'no' | 'notify' | 'yes' | string
  /** store-wide "Manage stock" setting; null when it could not be read */
  storeManageStock: boolean | null
  dateModifiedGmt: string | null
  // ---- filled by the connector (normalize.ts); optional so detection can be tested on minimal records
  /** per-item low-stock threshold; null = the store default */
  lowStockAmount?: number | null
  /** store-wide low-stock threshold (woocommerce_notify_low_stock_amount); null when it could not be read */
  storeLowStockAmount?: number | null
  regularPrice?: string | null
  salePrice?: string | null
  onSale?: boolean
  saleScheduled?: boolean
  /** neutral price fields: what a customer pays now, and the struck-through price while on sale */
  price?: string | null
  compareAtPrice?: string | null
  productTitle?: string
  variantTitle?: string
  variantId?: string
  productHandle?: string | null
  productTags?: string[]
  /** neutral status (ACTIVE, DRAFT, UNLISTED, SCHEDULED, ARCHIVED) and the raw WooCommerce status of the product */
  productStatus?: string
  wooProductStatus?: string
  variationStatus?: string
  published?: Record<string, boolean>
  barcodes?: string[]
  tracked?: boolean
  totalAvailable?: number | null
  isGiftCard?: boolean
}

export const WOO_BACKORDERS_CHECK = 'woocommerce.backorders_at_zero'
export const WOO_OVERSOLD_CHECK = 'woocommerce.oversold_no_backorders'
export const WOO_LOW_STOCK_CHECK = 'woocommerce.low_stock'
export const WOO_SET_BACKORDERS = 'woocommerce.product.set_backorders'
const DEFAULT_EXEMPT = ['preorder', 'pre-order', 'backorder', 'made-to-order', 'made to order']

export function wooResourceId(productId: number, variationId: number | null) { return variationId ? `variation:${productId}:${variationId}` : `product:${productId}` }
const label = (r: WooStockRecord) => `${r.name}${r.sku ? ` (SKU ${r.sku})` : ''}`

export const wooBackordersCheck: CheckDef<WooStockRecord, Finding> = {
  key: WOO_BACKORDERS_CHECK,
  platform: 'woocommerce',
  title: 'Taking backorders against your rule',
  description: 'Published products with managed stock at or below zero that still allow backorders, when your rule says they should stop selling at zero.',
  whyItIsAnError: 'Backorders can be intentional, so this only runs after you turn the rule on, and skips products tagged as pre-order or backorder and products you exempt. It also skips stores where stock management is switched off store-wide, because WooCommerce ignores the setting there.',
  kind: 'correctable',
  resourceType: 'woo_stock_object',
  defaultEnabled: false,
  defaultConfig: { exemptTags: DEFAULT_EXEMPT, exemptProductIds: [] },
  parseConfig(raw) {
    const r = (raw ?? {}) as Record<string, unknown>
    const tags = Array.isArray(r.exemptTags) ? r.exemptTags.map(t => String(t).trim().toLowerCase()).filter(Boolean) : DEFAULT_EXEMPT
    const ids = Array.isArray(r.exemptProductIds) ? r.exemptProductIds.map(Number).filter(n => Number.isInteger(n) && n > 0) : []
    return { exemptTags: [...new Set(tags)], exemptProductIds: [...new Set(ids)] }
  },
  detect(r, cfg): Finding | null {
    const c = cfg as { exemptTags: string[]; exemptProductIds: number[] }
    if (r.status !== 'publish' || r.manageStock !== true || r.storeManageStock === false) return null
    if (r.stockQuantity === null || r.stockQuantity > 0) return null
    if (r.backorders !== 'notify' && r.backorders !== 'yes') return null
    if (c.exemptProductIds.includes(r.productId)) return null
    if (r.tags.some(t => c.exemptTags.includes(t.trim().toLowerCase()))) return null
    const path = r.variationId ? `/products/${r.productId}/variations/${r.variationId}` : `/products/${r.productId}`
    return {
      checkKey: WOO_BACKORDERS_CHECK, kind: 'correctable', fingerprint: `${WOO_BACKORDERS_CHECK}:${r.resourceId}`,
      resourceType: r.resourceType, resourceId: r.resourceId, resourceLabel: label(r), severity: 'high',
      summary: `Taking backorders with ${r.stockQuantity} in stock (backorders: ${r.backorders}).`,
      evidence: { productId: r.productId, variationId: r.variationId, stockQuantity: r.stockQuantity, stockStatus: r.stockStatus, backorders: r.backorders, manageStock: r.manageStock, storeManageStock: r.storeManageStock, tags: r.tags, productTags: r.tags, fetchedAt: r.fetchedAt },
      correction: {
        actionKey: WOO_SET_BACKORDERS, targetType: 'woo_stock_object', targetId: r.resourceId, targetLabel: label(r),
        change: { field: 'backorders', from: r.backorders, to: 'no' }, params: { path },
        preconditions: [
          { path: 'backorders', equals: r.backorders, description: 'backorders are still allowed' },
          { path: 'manageStock', equals: true, description: 'stock is still managed on this item' },
          { path: 'status', equals: 'publish', description: 'the product is still published' },
        ],
      },
    }
  },
}

export const wooOversoldCheck: CheckDef<WooStockRecord, Finding> = {
  key: WOO_OVERSOLD_CHECK,
  platform: 'woocommerce',
  title: 'Oversold while backorders are off',
  description: 'Items with managed stock below zero even though backorders are not allowed.',
  whyItIsAnError: 'With backorders off, stock below zero means more was sold than was on hand. Only a stock count or receiving record can say the real quantity, so a person decides.',
  kind: 'needs_person',
  resourceType: 'woo_stock_object',
  defaultEnabled: true,
  defaultConfig: {},
  parseConfig: () => ({}),
  detect(r): Finding | null {
    if (r.manageStock !== true || r.backorders !== 'no' || r.stockQuantity === null || r.stockQuantity >= 0) return null
    return {
      checkKey: WOO_OVERSOLD_CHECK, kind: 'needs_person', fingerprint: `${WOO_OVERSOLD_CHECK}:${r.resourceId}`,
      resourceType: r.resourceType, resourceId: r.resourceId, resourceLabel: label(r), severity: 'high',
      summary: `Stock is ${r.stockQuantity} although backorders are off.`,
      evidence: { productId: r.productId, variationId: r.variationId, stockQuantity: r.stockQuantity, backorders: r.backorders, productTags: r.tags, fetchedAt: r.fetchedAt },
      humanAction: 'Count the stock or receive incoming inventory, and check the orders placed past zero. Deploi does not change stock quantities.',
    }
  },
}

export const wooLowStockCheck: CheckDef<WooStockRecord, Finding> = {
  key: WOO_LOW_STOCK_CHECK,
  platform: 'woocommerce',
  title: 'Low stock',
  description: 'Published items with managed stock at or below their WooCommerce low-stock threshold (the item\'s own, else the store default).',
  whyItIsAnError: 'It is not an error, it is a signal: WooCommerce\'s own threshold says the item needs restocking soon. Only a person or a supplier can restock, so this never proposes a change.',
  kind: 'needs_person',
  resourceType: 'woo_stock_object',
  defaultEnabled: false,
  defaultConfig: {},
  parseConfig: () => ({}),
  detect(r): Finding | null {
    if (r.status !== 'publish' || r.manageStock !== true || r.stockQuantity === null || r.stockQuantity < 0) return null
    const threshold = r.lowStockAmount ?? r.storeLowStockAmount ?? 2
    if (r.stockQuantity > threshold) return null
    return {
      checkKey: WOO_LOW_STOCK_CHECK, kind: 'needs_person', fingerprint: `${WOO_LOW_STOCK_CHECK}:${r.resourceId}`,
      resourceType: r.resourceType, resourceId: r.resourceId, resourceLabel: label(r), severity: r.stockQuantity === 0 ? 'medium' : 'low',
      summary: `${r.stockQuantity} in stock, at or below the low-stock threshold of ${threshold}.`,
      evidence: { productId: r.productId, variationId: r.variationId, stockQuantity: r.stockQuantity, lowStockAmount: r.lowStockAmount ?? null, storeLowStockAmount: r.storeLowStockAmount ?? null, threshold, productTags: r.tags, fetchedAt: r.fetchedAt },
      humanAction: 'Reorder from your supplier or receive incoming stock. Deploi does not change stock quantities.',
    }
  },
}
