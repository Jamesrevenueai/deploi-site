/**
 * Installation for the embedded app (Shopify managed installation + token exchange):
 * the first verified id token from a shop creates or re-activates the organization and the
 * connection, stores an encrypted expiring offline token, reads basic shop details and the
 * default rules. Uninstall and shop/redact undo it.
 */
import { admin, type Db } from '../../db'
import { audit } from '../../engine/audit'
import { ensureRules } from '../../engine/rules'
import { invalidateProposal, type ProposalRow } from '../../engine/proposals'
import { loadConnection } from '../../engine/scan'
import { storeCredential, loadCredential, deleteCredential } from '../credentials'
import { exchangeSessionToken, type AccessToken } from './auth'
import { realTransport } from './client'
import { Q_SHOP } from './queries'
import { shopifyConfig } from './config'

export type InstallResult = { connectionId: string; orgId: string; created: boolean; tokenExchanged: boolean }

async function shopInfo(shop: string, token: string) {
  try {
    const r = await realTransport(shop, token)({ query: Q_SHOP, operationName: 'DeploiShop' })
    const d = (r.json as { data?: { shop?: { name?: string; ianaTimezone?: string } } } | null)?.data?.shop
    return { name: d?.name ?? shop, timezone: d?.ianaTimezone ?? null }
  } catch { return { name: shop, timezone: null } }
}

/** Ensure the shop is installed and has a usable offline token. Idempotent; safe on every app load. */
export async function ensureInstalled(shop: string, idToken: string, opts: { exchange?: (shop: string, idToken: string) => Promise<AccessToken>; info?: typeof shopInfo; force?: boolean } = {}): Promise<InstallResult> {
  const existing = await admin(db => db.one<{ id: string; org_id: string; status: string }>(`select id, org_id, status from store_connections where platform = 'shopify' and external_id = $1`, [shop]))
  if (existing?.status === 'active' && !opts.force) {
    const cred = await admin(db => loadCredential(db, existing.id))
    const usable = cred && (!cred.refreshExpiresAt || new Date(cred.refreshExpiresAt).getTime() > Date.now() + 86400e3)
    if (usable) return { connectionId: existing.id, orgId: existing.org_id, created: false, tokenExchanged: false }
  }
  const token = await (opts.exchange ?? ((s, t) => exchangeSessionToken(s, t)))(shop, idToken)
  const info = await (opts.info ?? shopInfo)(shop, token.accessToken)
  return admin(async db => {
    let orgId = existing?.org_id
    const created = !existing
    if (!orgId) {
      const g = await db.one<{ id: string }>(`insert into agencies (name, state, timezone, org_type) values ($1,'',$2,'merchant') returning id`, [info.name, info.timezone ?? 'UTC'])
      orgId = g!.id
    }
    const conn = await db.one<{ id: string }>(
      `insert into store_connections (org_id, platform, external_id, display_name, status, scopes, api_version, is_synthetic, timezone, installed_at, uninstalled_at)
       values ($1,'shopify',$2,$3,'active',$4,$5,false,$6,now(),null)
       on conflict (platform, external_id) do update set status = 'active', scopes = excluded.scopes, api_version = excluded.api_version,
         display_name = excluded.display_name, timezone = excluded.timezone, installed_at = now(), uninstalled_at = null
       returning id`,
      [orgId, shop, info.name, token.scope.length ? token.scope : shopifyConfig.scopes, shopifyConfig.apiVersion, info.timezone])
    await storeCredential(db, {
      connectionId: conn!.id, orgId, secret: token.accessToken, tokenKind: 'offline', scopes: token.scope,
      expiresAt: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000) : null,
      refreshSecret: token.refreshToken, refreshExpiresAt: token.refreshTokenExpiresIn ? new Date(Date.now() + token.refreshTokenExpiresIn * 1000) : null,
      actor: `shopify:${shop}:install`,
    })
    const row = await loadConnection(db, conn!.id)
    if (row) await ensureRules(db, row)
    await audit(db, { orgId, connectionId: conn!.id, entityType: 'connection', entityId: conn!.id, event: created ? 'connection.installed' : 'connection.reauthorized', actor: `shopify:${shop}`, detail: { scopes: token.scope, api_version: shopifyConfig.apiVersion } })
    return { connectionId: conn!.id, orgId, created, tokenExchanged: true }
  })
}

/** app/uninstalled: stop everything for the shop. Credentials are deleted; live proposals are cancelled. */
export async function markUninstalled(db: Db, shop: string, actor: string) {
  const c = await db.one<{ id: string; org_id: string }>(`select id, org_id from store_connections where platform = 'shopify' and external_id = $1`, [shop])
  if (!c) return null
  await db.query(`update store_connections set status = 'uninstalled', uninstalled_at = now() where id = $1`, [c.id])
  await deleteCredential(db, c.id, c.org_id, actor, 'app uninstalled')
  const live = await db.query<ProposalRow>(`select * from proposals where connection_id = $1 and status in ('pending_approval','approved')`, [c.id])
  for (const p of live) await invalidateProposal(db, p, 'blocked', 'the app was uninstalled', actor)
  await audit(db, { orgId: c.org_id, connectionId: c.id, entityType: 'connection', entityId: c.id, event: 'connection.uninstalled', actor })
  return c.id
}

/**
 * shop/redact (sent after uninstall): erase the shop's data. The connection and everything hanging
 * off it are deleted (issues, proposals, executions, rules, scans, credentials, subscriptions); the
 * organization is deleted too when it has no other store, which removes its audit trail.
 */
export async function redactShop(db: Db, shop: string): Promise<{ deleted: boolean; orgDeleted: boolean }> {
  const c = await db.one<{ id: string; org_id: string }>(`select id, org_id from store_connections where platform = 'shopify' and external_id = $1`, [shop])
  if (!c) return { deleted: false, orgDeleted: false }
  await db.query('delete from store_connections where id = $1', [c.id])
  const others = await db.one<{ n: string }>('select count(*)::text as n from store_connections where org_id = $1', [c.org_id])
  const org = await db.one<{ org_type: string }>('select org_type from agencies where id = $1', [c.org_id])
  let orgDeleted = false
  if (Number(others?.n ?? 0) === 0 && org?.org_type === 'merchant') {
    await db.query('update profiles set agency_id = null where agency_id = $1', [c.org_id])
    await db.query('delete from agencies where id = $1', [c.org_id])
    orgDeleted = true
  }
  return { deleted: true, orgDeleted }
}
