/**
 * Store health: whether Deploi can read what it needs from each connected store (a store connected without
 * a read permission Deploi needs becomes a `store_access_missing` case), and a recommendation for the weekly
 * Store Health Checker, with a reason built from the catalog that was actually read.
 */
import { admin } from '../../db'
import { getConnector } from '../../engine/registry'
import { registerDetector, type DiscoveryFinding, type Detector } from '../registry'
import { activeStores, stockItems, storeLabel, storeSnapshot } from '../store'

export const STORE_HEALTH = 'store-health'
export const STORE_ACCESS_KIND = 'store_access_missing'

export const storeHealthDetector: Detector = {
  key: STORE_HEALTH, suite: 'commerce', sourceApp: 'shopify',
  available: async (db, orgId) => (await activeStores(db, orgId)).length > 0,
  async detect(ctx) {
    const stores = await admin(db => activeStores(db, ctx.orgId))
    const findings: DiscoveryFinding[] = []
    const sourcesRead: string[] = [], notes: string[] = []
    let items = 0, open = 0
    for (const conn of stores) {
      // Shopify reports the scopes it granted; WooCommerce keys are read/write pairs checked when connected
      if (conn.platform === 'shopify') {
        const missing = getConnector(conn.platform).requiredScopes.read.filter(s => !conn.scopes.includes(s))
        if (missing.length) findings.push({
          kind: STORE_ACCESS_KIND, sourceApp: conn.platform, dedupeKey: `store_access:${conn.id}:${missing.sort().join(',')}`.slice(0, 300),
          title: `Deploi cannot read everything it needs from ${storeLabel(conn)}`.slice(0, 300),
          problem: `The store was connected without these read permissions: ${missing.join(', ')}.`,
          whyItMatters: 'Without them some problems cannot be seen, so Deploi cannot tell you about them.',
          priority: 'high',
          evidence: [{ label: `Granted permissions do not include ${missing.join(', ')}`, source: conn.platform, observedAt: ctx.now.toISOString(), detail: { missing } }],
          records: [{ type: 'store_connection', id: conn.id, label: storeLabel(conn).slice(0, 200) }],
          verification: { criteria: 'The store connection is granted every read permission Deploi needs', rule: { type: 'scopes_granted', connectionId: conn.id, scopes: missing } },
        })
      }
      const snap = await storeSnapshot(ctx, conn)
      if (snap.error) { notes.push(`${storeLabel(conn)} not read: ${snap.error}`); continue }
      sourcesRead.push(`${conn.platform}:${conn.id}`)
      items += stockItems(snap).length
      const n = await admin(db => db.one<{ n: number }>(`select count(*)::int as n from issues where connection_id = $1 and status in ('open','needs_review')`, [conn.id]))
      open += n?.n ?? 0
    }
    if (!sourcesRead.length) return { findings, sourcesRead, notes, recommendation: null }
    return {
      findings, sourcesRead, notes,
      recommendation: {
        template: 'store_health_checker', suite: 'commerce', name: 'Store Health Checker',
        reason: `A weekly health report on the ${items} ${items === 1 ? 'item' : 'items'} read from your store${open ? ` (${open} ${open === 1 ? 'problem' : 'problems'} open now)` : ''}.`,
        needs: [],
      },
    }
  },
}

registerDetector(storeHealthDetector)
