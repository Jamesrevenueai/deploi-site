/**
 * The store read discovery shares between its store detectors and the profile: one full scan per connected
 * store per run (the existing engine scan: it reads products and inventory, records issues and proposals,
 * and never writes to the store), cached in the run's `shared` map so the catalog is read once.
 */
import type { Db } from '../db'
import { runScan, type ScanResult } from '../engine/scan'
import { getConnector } from '../engine/registry'
import type { ConnectionRow, ResourceRecord } from '../engine/types'
import { DEFAULT_EXEMPT_TAGS } from '../connectors/shopify/checks'
import type { DetectorContext } from './registry'
import '../connectors'

export const STORE_PLATFORMS = ['shopify', 'woocommerce'] as const
export const PLATFORM_LABEL: Record<string, string> = { shopify: 'Shopify', woocommerce: 'WooCommerce' }
/** Default low-stock threshold: the same number the Supplier Chaser template starts from. */
export const LOW_STOCK_THRESHOLD = 2

export type StoreSnapshot = { conn: ConnectionRow; records: ResourceRecord[]; scan: ScanResult | null; error: string | null; readAt: string }

/** Active, operational store connections of the organization. */
export async function activeStores(db: Db, orgId: string): Promise<ConnectionRow[]> {
  const rows = await db.query<ConnectionRow>(
    `select id, org_id, platform, external_id, display_name, status, scopes, api_version, is_synthetic, timezone, currency from store_connections
     where org_id = $1 and status = 'active' and platform = any($2::text[]) order by created_at`, [orgId, [...STORE_PLATFORMS]])
  return rows.filter(c => { try { return getConnector(c.platform).operational } catch { return false } })
}

export const storeLabel = (c: { platform: string; display_name: string | null; external_id: string }) => `${PLATFORM_LABEL[c.platform] ?? c.platform} (${c.display_name ?? c.external_id})`

/** Read the store once per run (cached in ctx.shared); a read failure is returned, not thrown. */
export function storeSnapshot(ctx: DetectorContext, conn: ConnectionRow): Promise<StoreSnapshot> {
  const key = `store:${conn.id}`
  const cached = ctx.shared?.get(key) as Promise<StoreSnapshot> | undefined
  if (cached) return cached
  const p = (async (): Promise<StoreSnapshot> => {
    let records: ResourceRecord[] = []
    try {
      // discovery opens its own `detected` cases for what it found (lib/discovery/run.ts); later scans, decisions and checks move them
      const scan = await runScan(conn.id, { trigger: 'manual', actor: 'system:discovery', syncCases: false, onRecords: r => { records = r } })
      return { conn, records, scan, error: null, readAt: new Date().toISOString() }
    } catch (e) {
      return { conn, records: [], scan: null, error: (e as Error).message.slice(0, 200), readAt: new Date().toISOString() }
    }
  })()
  ctx.shared?.set(key, p)
  return p
}

export type StockItem = { resourceId: string; productId: string; label: string; available: number | null; tracked: boolean; active: boolean; exempt: boolean; fetchedAt: string }

const EXEMPT = new Set(DEFAULT_EXEMPT_TAGS.map(t => t.toLowerCase()))
const exemptTags = (tags: unknown) => Array.isArray(tags) && tags.some(t => typeof t === 'string' && EXEMPT.has(t.trim().toLowerCase()))

/** A platform record in neutral stock terms (Shopify variants and WooCommerce stock objects). Unknown records are skipped. */
export function stockItem(r: ResourceRecord): StockItem | null {
  if (r.resourceType === 'variant') {
    const title = String(r.productTitle ?? '')
    const v = String(r.variantTitle ?? '')
    return {
      resourceId: r.resourceId, productId: String(r.productId ?? r.resourceId), label: `${title}${v && v !== 'Default Title' ? ` (${v})` : ''}${r.sku ? `, SKU ${r.sku}` : ''}`,
      available: typeof r.totalAvailable === 'number' ? r.totalAvailable : null, tracked: r.tracked === true, active: r.productStatus === 'ACTIVE',
      exempt: r.isGiftCard === true || r.requiresSellingPlan === true || exemptTags(r.productTags), fetchedAt: r.fetchedAt,
    }
  }
  if (r.resourceType === 'woo_stock_object') {
    const managed = r.manageStock === true
    return {
      resourceId: r.resourceId, productId: String(r.productId ?? r.resourceId), label: `${String(r.name ?? '')}${r.sku ? `, SKU ${r.sku}` : ''}`,
      available: managed && typeof r.stockQuantity === 'number' ? r.stockQuantity : null, tracked: managed, active: r.status === 'publish',
      exempt: exemptTags(r.tags), fetchedAt: r.fetchedAt,
    }
  }
  return null
}

export function stockItems(s: StoreSnapshot): StockItem[] {
  return s.records.map(stockItem).filter((x): x is StockItem => x !== null)
}

/** Items a low-stock alert applies to: tracked, on sale, not pre-order/backorder/gift card/subscription, 0..threshold available. */
export function lowStock(items: StockItem[], threshold = LOW_STOCK_THRESHOLD): StockItem[] {
  return items.filter(i => i.tracked && i.active && !i.exempt && i.available !== null && i.available >= 0 && i.available <= threshold)
}
