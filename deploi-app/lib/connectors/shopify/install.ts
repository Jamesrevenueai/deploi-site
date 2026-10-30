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
import { cancelAgentEmail } from '../../email/engine'
import { recordShopFacts, loadAccessRow, factsStale } from '../../engine/access'
import { shopifyGraphql } from './client'

export type InstallResult = { connectionId: string; orgId: string; created: boolean; tokenExchanged: boolean }

export type ShopInfo = { name: string; timezone: string | null; currency?: string | null; isDevelopmentStore?: boolean | null; planName?: string | null; shopGid?: string | null }
type ShopJson = { data?: { shop?: { id?: string; name?: string; ianaTimezone?: string; currencyCode?: string; plan?: { publicDisplayName?: string; partnerDevelopment?: boolean } } } } | null

export function parseShopInfo(shop: string, json: unknown): ShopInfo {
  const d = (json as ShopJson)?.data?.shop
  return {
    name: d?.name ?? shop, timezone: d?.ianaTimezone ?? null, currency: d?.currencyCode ?? null,
    isDevelopmentStore: typeof d?.plan?.partnerDevelopment === 'boolean' ? d.plan.partnerDevelopment : null,
    planName: d?.plan?.publicDisplayName ?? null,
    shopGid: typeof d?.id === 'string' && d.id.startsWith('gid://shopify/Shop/') ? d.id : null,
  }
}

async function shopInfo(shop: string, token: string): Promise<ShopInfo> {
  try {
    const r = await realTransport(shop, token)({ query: Q_SHOP, operationName: 'DeploiShop' })
    return parseShopInfo(shop, r.json)
  } catch { return { name: shop, timezone: null, currency: null, isDevelopmentStore: null, planName: null } }
}

/** Ensure the shop is installed and has a usable offline token. Idempotent; safe on every app load. */
export async function ensureInstalled(shop: string, idToken: string, opts: { exchange?: (shop: string, idToken: string) => Promise<AccessToken>; info?: (shop: string, token: string) => Promise<ShopInfo>; force?: boolean } = {}): Promise<InstallResult> {
  const existing = await admin(db => db.one<{ id: string; org_id: string; status: string; is_synthetic: boolean }>(`select id, org_id, status, is_synthetic from store_connections where platform = 'shopify' and external_id = $1`, [shop]))
  // a synthetic demo store never talks to Shopify, so it never exchanges tokens
  if (existing?.is_synthetic && existing.status === 'active') return { connectionId: existing.id, orgId: existing.org_id, created: false, tokenExchanged: false }
  if (existing?.status === 'active' && !opts.force) {
    const cred = await admin(db => loadCredential(db, existing.id))
    const usable = cred && (!cred.refreshExpiresAt || new Date(cred.refreshExpiresAt).getTime() > Date.now() + 86400e3)
    if (usable) return { connectionId: existing.id, orgId: existing.org_id, created: false, tokenExchanged: false }
  }
  const token = await (opts.exchange ?? ((s, t) => exchangeSessionToken(s, t)))(shop, idToken)
  const info = await (opts.info ?? shopInfo)(shop, token.accessToken)
  return admin(async db => {
    // one install per shop at a time: two first loads at once must not create two organizations
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [`shopify-install:${shop}`])
    const current = await db.one<{ id: string; org_id: string }>(`select id, org_id from store_connections where platform = 'shopify' and external_id = $1`, [shop])
    let orgId = current?.org_id ?? existing?.org_id
    const created = !current && !existing
    if (!orgId) {
      const g = await db.one<{ id: string }>(`insert into agencies (name, state, timezone, org_type) values ($1,'',$2,'merchant') returning id`, [info.name, info.timezone ?? 'UTC'])
      orgId = g!.id
    }
    const conn = await db.one<{ id: string }>(
      `insert into store_connections (org_id, platform, external_id, display_name, status, scopes, api_version, is_synthetic, timezone, currency, installed_at, uninstalled_at)
       values ($1,'shopify',$2,$3,'active',$4,$5,false,$6,$7,now(),null)
       on conflict (platform, external_id) do update set status = 'active', scopes = excluded.scopes, api_version = excluded.api_version,
         display_name = excluded.display_name, timezone = excluded.timezone, currency = coalesce(excluded.currency, store_connections.currency), installed_at = now(), uninstalled_at = null
       returning id`,
      [orgId, shop, info.name, token.scope.length ? token.scope : shopifyConfig.scopes, shopifyConfig.apiVersion, info.timezone, info.currency ?? null])
    await storeCredential(db, {
      connectionId: conn!.id, orgId, secret: token.accessToken, tokenKind: 'offline', scopes: token.scope,
      expiresAt: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000) : null,
      refreshSecret: token.refreshToken, refreshExpiresAt: token.refreshTokenExpiresIn ? new Date(Date.now() + token.refreshTokenExpiresIn * 1000) : null,
      actor: `shopify:${shop}:install`,
    })
    const row = await loadConnection(db, conn!.id)
    if (row) await ensureRules(db, row)
    if (info.shopGid) await db.query('update store_connections set shop_gid = $2 where id = $1', [conn!.id, info.shopGid])
    if (row) await recordShopFacts(db, row, { isDevelopmentStore: info.isDevelopmentStore ?? null, planName: info.planName ?? null }, `shopify:${shop}:install`)
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
  // every agent on this store stops: no runs, no writes, and no email (agent mailboxes do not depend on the store connection)
  const paused = await db.query<{ id: string }>(`update agents set status = 'paused', next_run_at = null where connection_id = $1 and status = 'active' returning id`, [c.id])
  await db.query(`update executions set status = 'blocked', status_reason = 'the app was uninstalled', finished_at = now() where connection_id = $1 and status in ('queued','prechecking')`, [c.id])
  let emailsCancelled = 0
  for (const a of paused) {
    emailsCancelled += await cancelAgentEmail(db, a.id, 'the app was uninstalled; queued messages are not sent', false)
    await audit(db, { orgId: c.org_id, connectionId: c.id, entityType: 'agent', entityId: a.id, event: 'agent.paused', actor, detail: { reason: 'app uninstalled' } })
  }
  await audit(db, { orgId: c.org_id, connectionId: c.id, entityType: 'connection', entityId: c.id, event: 'connection.uninstalled', actor, detail: { agents_paused: paused.length, emails_cancelled: emailsCancelled } })
  return c.id
}

/**
 * shop/redact (sent after uninstall): erase the shop's data. The connection and everything hanging
 * off it are deleted (issues, proposals, executions, rules, scans, credentials, subscriptions, store access); the
 * organization is deleted too when it has no other store, which removes its audit trail.
 */
export async function redactShop(db: Db, shop: string): Promise<{ deleted: boolean; orgDeleted: boolean }> {
  const c = await db.one<{ id: string; org_id: string }>(`select id, org_id from store_connections where platform = 'shopify' and external_id = $1`, [shop])
  if (!c) return { deleted: false, orgDeleted: false }
  await db.query('delete from store_connections where id = $1', [c.id])
  await db.query(`delete from store_access where platform = 'shopify' and external_id = $1`, [shop])
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

/**
 * Re-ask Shopify about the shop when the stored facts are older than a day (a development store can
 * be transferred to a merchant and stop being one). Failures leave the previous facts in place.
 */
export async function refreshShopFactsIfStale(connectionId: string, actor: string): Promise<void> {
  const conn = await admin(db => loadConnection(db, connectionId))
  if (!conn || conn.is_synthetic || conn.platform !== 'shopify' || conn.status !== 'active') return
  const row = await admin(db => loadAccessRow(db, conn.platform, conn.external_id))
  if (!factsStale(row)) return
  try {
    const json = await shopifyGraphql<unknown>(conn, { query: Q_SHOP, operationName: 'DeploiShop' })
    const info = parseShopInfo(conn.external_id, { data: json })
    await admin(async db => {
      if (info.shopGid) await db.query('update store_connections set shop_gid = $2 where id = $1', [conn.id, info.shopGid])
      await recordShopFacts(db, conn, { isDevelopmentStore: info.isDevelopmentStore ?? null, planName: info.planName ?? null }, actor)
    })
  } catch { /* keep the previous facts */ }
}
