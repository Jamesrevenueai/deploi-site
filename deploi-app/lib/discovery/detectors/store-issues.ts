/**
 * Store issues: wraps the existing store scan and checks (Shopify and WooCommerce: overselling, oversold
 * items, and the listing checks — price, SKU, publication — wherever they are configured) and turns every
 * open issue into a `detected` case of the issue's own kind (its check key, e.g. shopify_oversell_policy).
 * The case is the same problem as the issue: it is resolved when a fresh read of the store no longer shows it.
 */
import { admin, type Db } from '../../db'
import { allChecks, getCheck } from '../../engine/registry'
import { registerCaseKind, resolveCase, type CaseRow, type Priority } from '../../cases'
import { OVERSELL_CHECK, OVERSOLD_CHECK } from '../../connectors/shopify/checks'
import { WOO_BACKORDERS_CHECK, WOO_OVERSOLD_CHECK } from '../../connectors/woocommerce/checks'
import { registerDetector, type DiscoveryFinding, type Detector } from '../registry'
import { activeStores, storeLabel, storeSnapshot, PLATFORM_LABEL } from '../store'
import '../../connectors'

export const STORE_ISSUES = 'store-issues'
const STOCK_CHECKS = new Set([OVERSELL_CHECK, OVERSOLD_CHECK, WOO_BACKORDERS_CHECK, WOO_OVERSOLD_CHECK])
const MAX_CASES = 100
const RECHECK_MS = 24 * 3600e3

/** The case kind for an issue: its check key in case-kind form (shopify.oversell_policy -> shopify_oversell_policy). */
export function issueCaseKind(checkKey: string): string {
  const k = checkKey.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
  return /^[a-z]/.test(k) && k.length >= 3 ? k : `store_${k}`.slice(0, 60)
}
export const issueDedupeKey = (connectionId: string, fingerprint: string) => `store:${connectionId}:${fingerprint}`.slice(0, 300)
const PRIORITY: Record<string, Priority> = { high: 'high', medium: 'normal', low: 'low' }

type IssueLite = { id: string; connection_id: string; platform: string; check_key: string; resource_type: string; resource_id: string; resource_label: string | null; fingerprint: string; severity: string; evidence: { summary?: string; humanAction?: string | null }; last_seen_at: string }

function toFinding(i: IssueLite): DiscoveryFinding {
  const check = getCheck(i.check_key)
  const label = i.resource_label ?? i.resource_id
  return {
    kind: issueCaseKind(i.check_key), sourceApp: i.platform,
    dedupeKey: issueDedupeKey(i.connection_id, i.fingerprint),
    title: `${check?.title ?? i.check_key}: ${label}`,
    problem: i.evidence?.summary ?? `${check?.title ?? i.check_key} on ${label}.`,
    whyItMatters: check?.whyItIsAnError,
    priority: PRIORITY[i.severity] ?? 'normal',
    evidence: [{ label: i.evidence?.summary ?? check?.title ?? i.check_key, source: i.platform, observedAt: i.last_seen_at, detail: { checkKey: i.check_key, severity: i.severity }, ref: { type: 'issue', id: i.id } }],
    records: [{ type: 'issue', id: i.id, label: check?.title ?? i.check_key }, { type: 'store_resource', id: i.resource_id, label }],
    verification: { criteria: 'A fresh read of the store no longer shows this problem', rule: { type: 'store_issue_cleared', connectionId: i.connection_id, fingerprint: i.fingerprint } },
  }
}

export const storeIssuesDetector: Detector = {
  key: STORE_ISSUES, suite: 'commerce', sourceApp: 'shopify',
  available: async (db, orgId) => (await activeStores(db, orgId)).length > 0,
  async detect(ctx) {
    const stores = await admin(db => activeStores(db, ctx.orgId))
    const findings: DiscoveryFinding[] = []
    const sourcesRead: string[] = [], notes: string[] = []
    let stock = 0
    for (const conn of stores) {
      const snap = await storeSnapshot(ctx, conn)
      if (snap.error) { notes.push(`${storeLabel(conn)} not read: ${snap.error}`); continue }
      sourcesRead.push(`${conn.platform}:${conn.id}`)
      const issues = await admin(db => db.query<IssueLite>(
        `select id, connection_id, platform, check_key, resource_type, resource_id, resource_label, fingerprint, severity, evidence, last_seen_at from issues
         where connection_id = $1 and status in ('open','needs_review') order by case severity when 'high' then 0 when 'medium' then 1 else 2 end, first_detected_at limit $2`, [conn.id, MAX_CASES + 1]))
      if (issues.length > MAX_CASES) notes.push(`${storeLabel(conn)}: more than ${MAX_CASES} open problems; the first ${MAX_CASES} became cases`)
      for (const i of issues.slice(0, MAX_CASES)) {
        findings.push(toFinding(i))
        if (STOCK_CHECKS.has(i.check_key)) stock++
      }
    }
    const platforms = [...new Set(stores.map(s => PLATFORM_LABEL[s.platform] ?? s.platform))].join(' and ')
    return {
      findings, sourcesRead, notes,
      recommendation: stock > 0 ? {
        template: 'inventory_watcher', suite: 'commerce', name: 'Inventory Watcher',
        reason: `${stock} ${stock === 1 ? 'item is' : 'items are'} oversold or set to keep selling at zero stock in ${platforms}.`,
        needs: [],
      } : null,
    }
  },
}

/** Checker for store-issue cases: resolved once the latest read no longer shows the problem (the issue is resolved). */
export async function checkStoreIssueCase(c: CaseRow, now: Date) {
  const rule = (c.verification as { rule?: { connectionId?: string; fingerprint?: string } }).rule
  if (!rule?.connectionId || !rule.fingerprint) return
  const latest = await admin(db => db.one<{ status: string; resolved_at: string | null; resolution: string | null; platform: string }>(
    `select status, resolved_at, resolution, platform from issues where connection_id = $1 and fingerprint = $2 order by first_detected_at desc limit 1`, [rule.connectionId, rule.fingerprint]))
  if (latest && latest.status === 'resolved' && latest.resolved_at) {
    const resolvedAt = latest.resolved_at
    await admin(db => resolveCase(db, c.id, {
      actor: 'system:discovery', summary: latest.resolution === 'verified_fix' ? 'Fixed and verified on a fresh read of the store' : 'No longer detected on the latest read of the store',
      verifiedBy: `${latest.platform} read`, evidence: [{ label: 'The problem is no longer present in the store', source: latest.platform, observedAt: resolvedAt, detail: { resolution: latest.resolution } }],
    }))
    return
  }
  await admin(db => setNextCheck(db, c.id, new Date(now.getTime() + RECHECK_MS)))
}

export const setNextCheck = (db: Db, caseId: string, at: Date) => db.query('update cases set next_check_at = $2 where id = $1', [caseId, at.toISOString()])

registerDetector(storeIssuesDetector)
for (const check of allChecks()) registerCaseKind(issueCaseKind(check.key), checkStoreIssueCase)
