/**
 * WooCommerce REST JSON -> WooStockRecord. One record per product (simple, variable parent, grouped,
 * external) and one per variation. Stock checks act only on the stock-owning object (manage_stock true);
 * a variation that inherits stock reports manage_stock "parent" and is left to its parent. Price and SKU
 * checks act on the sellable object (simple product or variation).
 * Besides the WooCommerce values, each record carries the neutral fields shared engine code reads
 * (productTitle, productTags, productStatus, tracked, totalAvailable, barcodes, ...).
 */
import { canonicalMoney } from '../../agents/references'
import { WOO_STOREFRONT } from './config'
import { wooResourceId, type WooStockRecord } from './checks'

export type WooTagJson = { id?: number; name?: string; slug?: string }
export type WooProductJson = {
  id: number; name?: string; slug?: string; type?: string; status?: string; sku?: string | null
  regular_price?: string | null; sale_price?: string | null; on_sale?: boolean
  manage_stock?: boolean | 'parent'; stock_quantity?: number | null; stock_status?: string; backorders?: string
  low_stock_amount?: number | null; tags?: WooTagJson[]; variations?: number[]; date_modified_gmt?: string | null
  global_unique_id?: string | null; parent_id?: number
}
export type WooVariationJson = Omit<WooProductJson, 'tags' | 'variations' | 'slug' | 'name' | 'type'> & { attributes?: { name?: string; option?: string }[] }
export type WooStoreSettings = { manageStock: boolean | null; lowStockAmount: number | null; currency: string | null }

/** Woo status vocabulary -> the neutral product status shared code understands. */
export function neutralStatus(s: string): string {
  return s === 'publish' ? 'ACTIVE' : s === 'draft' || s === 'pending' ? 'DRAFT' : s === 'private' ? 'UNLISTED' : s === 'future' ? 'SCHEDULED' : 'ARCHIVED'
}

const money = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? null : canonicalMoney(String(v)) ?? String(v))
const intOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null)

function prices(j: { regular_price?: string | null; sale_price?: string | null; on_sale?: boolean }) {
  const regularPrice = money(j.regular_price)
  const salePrice = money(j.sale_price)
  const onSale = j.on_sale === true && salePrice !== null
  return {
    regularPrice, salePrice, onSale,
    /** what a customer pays now, and the higher reference price shown struck through (Shopify terms) */
    price: onSale ? salePrice : regularPrice,
    compareAtPrice: onSale ? regularPrice : null,
    /** a sale price that is set but not running (scheduled or expired): price corrections go to a person */
    saleScheduled: salePrice !== null && !onSale,
  }
}

export function normalizeProduct(p: WooProductJson, s: WooStoreSettings, fetchedAt: string): WooStockRecord {
  const status = String(p.status ?? 'publish')
  const tags = (p.tags ?? []).map(t => String(t.name ?? t.slug ?? '')).filter(Boolean)
  const manageStock = p.manage_stock === true
  const stockQuantity = manageStock ? intOrNull(p.stock_quantity) : null
  const type = String(p.type ?? 'simple')
  const gtin = typeof p.global_unique_id === 'string' && p.global_unique_id.trim() ? [p.global_unique_id.trim()] : []
  return {
    resourceType: 'woo_stock_object', resourceId: wooResourceId(p.id, null), fetchedAt,
    productId: p.id, variationId: null, name: String(p.name ?? `Product ${p.id}`), sku: p.sku ? String(p.sku) : null, type, status, tags,
    manageStock, stockQuantity, stockStatus: String(p.stock_status ?? 'instock'), backorders: String(p.backorders ?? 'no'),
    storeManageStock: s.manageStock, dateModifiedGmt: p.date_modified_gmt ?? null,
    lowStockAmount: intOrNull(p.low_stock_amount), storeLowStockAmount: s.lowStockAmount,
    ...prices(p),
    productTitle: String(p.name ?? `Product ${p.id}`), variantTitle: type === 'variable' ? '' : 'Default Title', variantId: wooResourceId(p.id, null),
    productHandle: p.slug ? String(p.slug) : null, productTags: tags, productStatus: neutralStatus(status), wooProductStatus: status,
    published: { [WOO_STOREFRONT]: status === 'publish' }, barcodes: gtin,
    tracked: manageStock, totalAvailable: manageStock ? stockQuantity : null, isGiftCard: false,
  }
}

export function normalizeVariation(parent: WooStockRecord, v: WooVariationJson, fetchedAt: string): WooStockRecord {
  const own = String(v.status ?? 'publish')
  // a variation is live only when it is enabled and its product is published
  const status = parent.wooProductStatus !== 'publish' ? String(parent.wooProductStatus) : own
  const manageStock: boolean | 'parent' = v.manage_stock === 'parent' ? 'parent' : v.manage_stock === true
  const stockQuantity = manageStock === false ? null : intOrNull(v.stock_quantity)
  const title = (v.attributes ?? []).map(a => String(a.option ?? '')).filter(Boolean).join(' / ') || `Variation ${v.id}`
  const gtin = typeof v.global_unique_id === 'string' && v.global_unique_id.trim() ? [v.global_unique_id.trim()] : []
  return {
    ...parent,
    resourceId: wooResourceId(parent.productId, v.id), fetchedAt,
    variationId: v.id, name: `${parent.name} / ${title}`, sku: v.sku ? String(v.sku) : null, type: 'variation', status,
    manageStock, stockQuantity, stockStatus: String(v.stock_status ?? 'instock'), backorders: String(v.backorders ?? 'no'),
    dateModifiedGmt: v.date_modified_gmt ?? null, lowStockAmount: intOrNull(v.low_stock_amount),
    ...prices(v),
    variantTitle: title, variantId: wooResourceId(parent.productId, v.id), variationStatus: own, productStatus: neutralStatus(status), barcodes: gtin,
    tracked: manageStock === true, totalAvailable: manageStock === true ? stockQuantity : null,
  }
}
