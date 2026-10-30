/**
 * Access scopes, least privilege by default. The app installs with read-only scopes (config.ts REQUIRED_SCOPES).
 * Every write scope is optional: the embedded app asks Shopify for it (App Bridge `shopify.scopes.request`) only
 * when a merchant widens an agent past "drafts only", so a store that only ever drafts never grants a write scope.
 * The server learns what is granted from Shopify alone (currentAppInstallation.accessScopes here, and the
 * app/scopes_update webhook), never from the browser; executions re-check the granted list before every write.
 */
import type { Db } from '../../db'
import { audit } from '../../engine/audit'
import { correctionCapability } from '../../engine/capabilities'
import type { ConnectionRow, Platform } from '../../engine/types'
import { shopifyGraphql } from './client'
import { Q_ACCESS_SCOPES } from './queries'
import { ACTION_SCOPES, shopifyConfig } from './config'

type PolicyScopes = { correctionTypes: readonly string[]; approvalMode: string }

/** Scopes a policy needs beyond the read-only install: none at drafts only, otherwise the write scope of each correction it may make. */
export function scopesForPolicy(platform: string, policy: PolicyScopes): string[] {
  if (platform !== 'shopify' || policy.approvalMode === 'draft') return []
  const out = new Set<string>()
  for (const t of policy.correctionTypes) {
    const cap = correctionCapability(platform as Platform, t as Parameters<typeof correctionCapability>[1])
    for (const action of Object.keys(cap?.actions ?? {})) for (const s of ACTION_SCOPES[action] ?? []) out.add(s)
  }
  return [...out].sort()
}

export const missingScopes = (granted: readonly string[], needed: readonly string[]) => needed.filter(s => !granted.includes(s))

export function missingScopesForPolicy(conn: { platform: string; scopes: readonly string[] }, policy: PolicyScopes): string[] {
  return missingScopes(conn.scopes, scopesForPolicy(conn.platform, policy))
}

/** Re-read the granted scopes from Shopify and store them. Returns the granted list and whether it changed. */
export async function syncScopes(db: Db, conn: ConnectionRow, actor: string): Promise<{ granted: string[]; changed: boolean }> {
  const data = await shopifyGraphql<{ currentAppInstallation: { accessScopes: { handle: string }[] } }>(conn, { query: Q_ACCESS_SCOPES, operationName: 'DeploiAccessScopes' })
  const granted = [...new Set(data.currentAppInstallation.accessScopes.map(s => s.handle))].sort()
  const before = [...conn.scopes].sort()
  const changed = granted.join(',') !== before.join(',')
  if (changed) {
    await db.query('update store_connections set scopes = $2 where id = $1', [conn.id, granted])
    await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'connection', entityId: conn.id, event: 'connection.scopes_synced', actor, detail: { before, after: granted } })
  }
  return { granted, changed }
}

/** What the merchant can be asked for at runtime (declared as optional_scopes in shopify.app.toml). */
export const requestableScopes = () => shopifyConfig.optionalScopes

/**
 * Scopes for an authorization-code request: the required install scopes plus any of the app's declared
 * optional scopes the merchant asked to grant (`request=write_products`). Anything not declared optional is
 * ignored, so the link cannot be used to ask for more than the app's own configuration allows.
 */
export function authorizeScopes(requested: string | null | undefined, required = shopifyConfig.scopes, optional = shopifyConfig.optionalScopes): string[] {
  const asked = (requested ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const extra = asked.filter(s => optional.includes(s) && !required.includes(s))
  return [...required, ...new Set(extra)]
}
