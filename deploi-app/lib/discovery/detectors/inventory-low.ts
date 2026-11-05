/**
 * Low inventory: items on sale with stock tracked and 0 to 2 available (the default threshold; pre-order,
 * backorder, gift card and subscription items are left out). Each becomes an `inventory_low` case, resolved
 * once a fresh read shows more than the threshold available. Recommends the Inventory Watcher, and the
 * Supplier Chaser for restock requests — which needs the supplier's email address, never guessed.
 */
import { admin } from '../../db'
import { getConnector } from '../../engine/registry'
import { loadConnection } from '../../engine/scan'
import { registerCaseKind, resolveCase, transitionCase, type CaseRow } from '../../cases'
import { registerDetector, type DiscoveryFinding, type Detector } from '../registry'
import { activeStores, lowStock, stockItem, stockItems, storeLabel, storeSnapshot, LOW_STOCK_THRESHOLD } from '../store'
import { setNextCheck } from './store-issues'

export const INVENTORY_LOW = 'inventory-low'
export const INVENTORY_LOW_KIND = 'inventory_low'
const MAX_CASES = 50
const RECHECK_MS = 24 * 3600e3

export const lowStockDedupeKey = (connectionId: string, resourceId: string) => `low_stock:${connectionId}:${resourceId}`.slice(0, 300)

export const inventoryLowDetector: Detector = {
  key: INVENTORY_LOW, suite: 'commerce', sourceApp: 'shopify',
  available: async (db, orgId) => (await activeStores(db, orgId)).length > 0,
  async detect(ctx) {
    const stores = await admin(db => activeStores(db, ctx.orgId))
    const findings: DiscoveryFinding[] = []
    const sourcesRead: string[] = [], notes: string[] = []
    let total = 0
    for (const conn of stores) {
      const snap = await storeSnapshot(ctx, conn)
      if (snap.error) { notes.push(`${storeLabel(conn)} not read: ${snap.error}`); continue }
      sourcesRead.push(`${conn.platform}:${conn.id}`)
      const low = lowStock(stockItems(snap)).sort((a, b) => (a.available! - b.available!) || a.label.localeCompare(b.label))
      total += low.length
      if (low.length > MAX_CASES) notes.push(`${storeLabel(conn)}: ${low.length} items are low; the ${MAX_CASES} lowest became cases`)
      for (const i of low.slice(0, MAX_CASES)) findings.push({
        kind: INVENTORY_LOW_KIND, sourceApp: conn.platform,
        dedupeKey: lowStockDedupeKey(conn.id, i.resourceId),
        title: `Low stock: ${i.label}`.slice(0, 300),
        problem: `${i.available} available, at or below the low-stock threshold of ${LOW_STOCK_THRESHOLD}.`,
        whyItMatters: 'Once it sells out, customers cannot buy it (or it oversells) until it is restocked.',
        priority: i.available === 0 ? 'high' : 'normal',
        evidence: [{ label: `${i.available} available`, source: conn.platform, observedAt: i.fetchedAt, detail: { available: i.available, threshold: LOW_STOCK_THRESHOLD } }],
        records: [{ type: 'store_resource', id: i.resourceId, label: i.label.slice(0, 200) }],
        verification: { criteria: `A fresh read of the store shows more than ${LOW_STOCK_THRESHOLD} available`, rule: { type: 'stock_above', connectionId: conn.id, resourceId: i.resourceId, threshold: LOW_STOCK_THRESHOLD } },
      })
    }
    if (!total) return { findings, sourcesRead, notes, recommendation: null }
    const reason = `${total} ${total === 1 ? 'item has' : 'items have'} ${LOW_STOCK_THRESHOLD} or fewer in stock.`
    return {
      findings, sourcesRead, notes,
      recommendation: { template: 'inventory_watcher', suite: 'commerce', name: 'Inventory Watcher', reason, needs: [] },
      recommendations: [{ template: 'supplier_chaser', suite: 'commerce', name: 'Supplier Chaser', reason: `${reason} A restock request to your supplier can be drafted for each.`, needs: ["your supplier's email address"] }],
    }
  },
}

/** Checker for low-stock cases: a fresh read of the one item. */
export async function checkLowStockCase(c: CaseRow, now: Date): Promise<void> {
  const rule = (c.verification as { rule?: { connectionId?: string; resourceId?: string; threshold?: number } }).rule
  if (!rule?.connectionId || !rule.resourceId) return
  const conn = await admin(db => loadConnection(db, rule.connectionId!))
  const later = async () => { await admin(db => setNextCheck(db, c.id, new Date(now.getTime() + RECHECK_MS))) }
  if (!conn || conn.status !== 'active') return later()
  const read = await getConnector(conn.platform).readResources(conn, [rule.resourceId])
  const r = read.get(rule.resourceId)
  if (!r) {
    await admin(db => transitionCase(db, c.id, { to: 'cancelled', actor: 'system:discovery', reason: 'The item is no longer in the store' }))
    return
  }
  const item = stockItem(r)
  const threshold = rule.threshold ?? LOW_STOCK_THRESHOLD
  if (item && item.available !== null && item.available > threshold) {
    await admin(db => resolveCase(db, c.id, { actor: 'system:discovery', summary: `Restocked: ${item.available} available`, verifiedBy: `${conn.platform} read`,
      evidence: [{ label: `${item.available} available`, source: conn.platform, observedAt: r.fetchedAt, detail: { available: item.available, threshold } }] }))
    return
  }
  return later()
}

registerDetector(inventoryLowDetector)
registerCaseKind(INVENTORY_LOW_KIND, checkLowStockCase)
