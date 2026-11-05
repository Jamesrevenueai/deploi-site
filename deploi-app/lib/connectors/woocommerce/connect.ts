/**
 * Connecting and disconnecting a WooCommerce store.
 *  - probeStore: a live, read-only check that the key works against the store (system status for the
 *    WooCommerce version, the store currency, the site name). Nothing is stored until it passes.
 *  - connectStore: binds the store to one organization (a store already connected to another
 *    organization is refused), stores the key pair encrypted (token_kind api_key_pair), records the
 *    WooCommerce facts, creates the default rules and registers webhooks.
 *  - disconnectStore: deletes the webhooks from the store, deletes the stored key pair, stops every
 *    agent, proposal and queued write on the store. WooCommerce has no REST endpoint to revoke a key, so
 *    the merchant is told to delete it in WooCommerce > Settings > Advanced > REST API.
 */
import { admin } from '../../db'
import { audit } from '../../engine/audit'
import { ensureRules } from '../../engine/rules'
import { EngineError } from '../../engine/errors'
import { loadConnection } from '../../engine/scan'
import { invalidateProposal, type ProposalRow } from '../../engine/proposals'
import { storeCredential, deleteCredential } from '../credentials'
import { cancelAgentEmail } from '../../email/engine'
import type { ConnectionRow } from '../../engine/types'
import { encodeCreds, validCreds, wooRequest, siteFor, WooApiError, type AuthMode, type WooCreds, type WooSite } from './client'
import { realWooTransport, type WooTransport } from './http'
import { normalizeSiteUrl } from './url'
import { WC_API_VERSION, WC_MIN_VERSION, scopesForPermission } from './config'
import { registerWebhooks, deleteWebhooks } from './webhooks'
import { restoredIfBroken } from '../../integrations/events'

export type StoreFacts = { authMode: AuthMode; wcVersion: string; wpVersion: string | null; currency: string | null; name: string | null; timezone: string | null }
export type ConnectDeps = { transport?: WooTransport }

export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map(n => parseInt(n, 10) || 0), b = min.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) }
  return true
}

/** Plain-language reason for a failed probe; never includes the key. */
function probeFailure(e: unknown): EngineError {
  const err = e as WooApiError
  if (err instanceof WooApiError) {
    if (err.kind === 'auth') return new EngineError('invalid_input', 'WooCommerce refused the key. Check that it is a Read/Write key created by an administrator or shop manager, and that it has not been deleted.')
    if (err.kind === 'not_found') return new EngineError('invalid_input', 'No WooCommerce REST API was found at that address. Check the address, that WooCommerce is active, and that permalinks are not set to "Plain".')
    if (err.kind === 'rejected') return new EngineError('invalid_input', `The store refused the request: ${err.message.slice(0, 160)}`)
    return new EngineError('invalid_input', `The store did not answer properly: ${err.message.slice(0, 160)}`)
  }
  return new EngineError('invalid_input', `Could not reach the store: ${(e as Error).message.slice(0, 160)}`)
}

/** Read-only live check of a key against a store. Falls back to query-string credentials when the host strips the Authorization header. */
export async function probeStore(siteUrl: string, creds: WooCreds, deps: ConnectDeps = {}): Promise<StoreFacts> {
  const transport = deps.transport ?? realWooTransport(new URL(siteUrl).hostname)
  let site: WooSite = { siteUrl, creds, authMode: 'basic', transport }
  let status: { environment?: { version?: string; wp_version?: string } }
  try {
    status = (await wooRequest<typeof status>(site, { path: '/system_status' }, { maxAttempts: 2 })).data
  } catch (e) {
    if (!(e instanceof WooApiError && e.kind === 'auth' && /consumer key is missing|missing parameter/i.test(e.message))) throw probeFailure(e)
    site = { ...site, authMode: 'query' }
    try { status = (await wooRequest<typeof status>(site, { path: '/system_status' }, { maxAttempts: 2 })).data } catch (e2) { throw probeFailure(e2) }
  }
  const wcVersion = String(status?.environment?.version ?? '')
  if (!/^\d+\.\d+/.test(wcVersion)) throw new EngineError('invalid_input', 'The store did not report a WooCommerce version; is WooCommerce active?')
  if (!versionAtLeast(wcVersion, WC_MIN_VERSION)) throw new EngineError('invalid_input', `WooCommerce ${wcVersion} is too old; Deploi needs ${WC_MIN_VERSION} or newer.`)
  let currency: string | null = null
  try { const c = String((await wooRequest<{ value?: string }>(site, { path: '/settings/general/woocommerce_currency' }, { maxAttempts: 2 })).data.value ?? ''); currency = /^[A-Z]{3}$/.test(c) ? c : null } catch { currency = null }
  let name: string | null = null, timezone: string | null = null
  try {
    const root = (await wooRequest<{ name?: string; timezone_string?: string }>(site, { path: '/wp-json/' }, { maxAttempts: 2 })).data
    name = typeof root.name === 'string' && root.name.trim() ? root.name.trim().slice(0, 120) : null
    timezone = typeof root.timezone_string === 'string' && /^[A-Za-z_]+\/[A-Za-z_\/-]+$/.test(root.timezone_string) ? root.timezone_string : null
  } catch { /* optional */ }
  return { authMode: site.authMode, wcVersion, wpVersion: typeof status?.environment?.wp_version === 'string' ? status.environment.wp_version : null, currency, name, timezone }
}

export type ConnectInput = {
  orgId: string; actor: string; siteUrl: string; creds: WooCreds
  /** the key's permission as WooCommerce reported it (authorize flow) or as the merchant stated it (manual keys) */
  permissions: 'read' | 'read_write'
  via: 'authorize' | 'manual'
  remoteKeyId?: number | null
}

/** Validate the key live, then bind the store to the organization and store the key encrypted. */
export async function connectStore(input: ConnectInput, deps: ConnectDeps = {}): Promise<{ connectionId: string; created: boolean; webhooksError: string | null }> {
  const n = normalizeSiteUrl(input.siteUrl)
  if (!n.ok) throw new EngineError('invalid_input', n.reason)
  if (!validCreds(input.creds)) throw new EngineError('invalid_input', 'that does not look like a WooCommerce key pair (ck_… and cs_…)')
  const siteUrl = n.siteUrl
  // refuse early (before any network call) when another organization already owns this store
  const owner = await admin(db => db.one<{ org_id: string }>(`select org_id from store_connections where platform = 'woocommerce' and external_id = $1`, [siteUrl]))
  if (owner && owner.org_id !== input.orgId) throw new EngineError('forbidden', 'This store is already connected to another Deploi account.')
  const facts = await probeStore(siteUrl, input.creds, deps)
  const scopes = scopesForPermission(input.permissions)
  const result = await admin(async db => {
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [`woocommerce-connect:${siteUrl}`])
    const current = await db.one<{ id: string; org_id: string; status: string }>(`select id, org_id, status from store_connections where platform = 'woocommerce' and external_id = $1`, [siteUrl])
    if (current && current.org_id !== input.orgId) throw new EngineError('forbidden', 'This store is already connected to another Deploi account.')
    const conn = (await db.one<{ id: string }>(
      `insert into store_connections (org_id, platform, external_id, display_name, status, scopes, api_version, is_synthetic, timezone, currency, installed_at, uninstalled_at)
       values ($1,'woocommerce',$2,$3,'active',$4,$5,false,$6,$7,now(),null)
       on conflict (platform, external_id) do update set status = 'active', status_reason = null, reauth_required_at = null, scopes = excluded.scopes, api_version = excluded.api_version, display_name = coalesce(excluded.display_name, store_connections.display_name),
         timezone = coalesce(excluded.timezone, store_connections.timezone), currency = coalesce(excluded.currency, store_connections.currency), installed_at = now(), uninstalled_at = null
       returning id`,
      [input.orgId, siteUrl, facts.name ?? n.host, scopes, WC_API_VERSION, facts.timezone, facts.currency]))!
    await storeCredential(db, { connectionId: conn.id, orgId: input.orgId, secret: encodeCreds(input.creds), tokenKind: 'api_key_pair', scopes, actor: input.actor })
    await db.query(
      `insert into woo_connections (connection_id, org_id, site_url, auth_mode, connected_via, wc_version, wp_version, remote_key_id) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (connection_id) do update set site_url = excluded.site_url, auth_mode = excluded.auth_mode, connected_via = excluded.connected_via, wc_version = excluded.wc_version,
         wp_version = excluded.wp_version, remote_key_id = excluded.remote_key_id`,
      [conn.id, input.orgId, siteUrl, facts.authMode, input.via, facts.wcVersion, facts.wpVersion, input.remoteKeyId ?? null])
    const row = await loadConnection(db, conn.id)
    if (row) await ensureRules(db, row)
    await audit(db, { orgId: input.orgId, connectionId: conn.id, entityType: 'connection', entityId: conn.id, event: current ? 'connection.reauthorized' : 'connection.installed', actor: input.actor,
      detail: { platform: 'woocommerce', via: input.via, scopes, wc_version: facts.wcVersion, auth_mode: facts.authMode, currency: facts.currency } })
    // integration hub: reconnecting the same store keeps its id; a broken one gets its health back
    if (current) await restoredIfBroken(db, { orgId: input.orgId, integration: 'woocommerce', connectionId: conn.id, actor: input.actor, rowBroken: current.status !== 'active' })
    return { connectionId: conn.id, created: !current, row: row! }
  })
  // webhooks after the connection exists (best effort)
  let webhooksError: string | null = null
  try {
    const site = deps.transport ? { siteUrl, creds: input.creds, authMode: facts.authMode, transport: deps.transport } : await siteFor(result.row)
    webhooksError = (await registerWebhooks(result.row, site, input.actor)).error
  } catch (e) { webhooksError = (e as Error).message.slice(0, 200) }
  return { connectionId: result.connectionId, created: result.created, webhooksError }
}

/** Disconnect: remove our webhooks from the store, delete the key pair, stop all work on the store. */
export async function disconnectStore(orgId: string, connectionId: string, actor: string, deps: ConnectDeps = {}): Promise<{ webhooksDeleted: number }> {
  const conn = await admin(db => loadConnection(db, connectionId))
  if (!conn || conn.org_id !== orgId || conn.platform !== 'woocommerce') throw new EngineError('not_found', 'connection not found')
  let webhooksDeleted = 0
  try {
    const site = deps.transport ? { ...(await siteFor(conn)), transport: deps.transport } : await siteFor(conn)
    webhooksDeleted = await deleteWebhooks(conn, site, actor)
  } catch { /* the key may already be revoked; the stored ids are cleared below */ }
  await admin(async db => stopConnection(db, conn, actor, 'store disconnected'))
  return { webhooksDeleted }
}

export async function stopConnection(db: import('../../db').Db, conn: ConnectionRow, actor: string, reason: string) {
  await db.query(`update store_connections set status = 'disconnected', uninstalled_at = now() where id = $1`, [conn.id])
  await deleteCredential(db, conn.id, conn.org_id, actor, reason)
  await db.query(`update woo_connections set webhook_ids = '{}', webhook_key_id = null, webhook_secret_ciphertext = null where connection_id = $1`, [conn.id])
  const live = await db.query<ProposalRow>(`select * from proposals where connection_id = $1 and status in ('pending_approval','approved')`, [conn.id])
  for (const p of live) await invalidateProposal(db, p, 'blocked', reason, actor)
  const paused = await db.query<{ id: string }>(`update agents set status = 'paused', next_run_at = null where connection_id = $1 and status = 'active' returning id`, [conn.id])
  await db.query(`update executions set status = 'blocked', status_reason = $2, finished_at = now() where connection_id = $1 and status in ('queued','prechecking')`, [conn.id, reason])
  let emailsCancelled = 0
  for (const a of paused) {
    emailsCancelled += await cancelAgentEmail(db, a.id, `${reason}; queued messages are not sent`, false)
    await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'agent', entityId: a.id, event: 'agent.paused', actor, detail: { reason } })
  }
  await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'connection', entityId: conn.id, event: 'connection.disconnected', actor, detail: { platform: 'woocommerce', agents_paused: paused.length, emails_cancelled: emailsCancelled, revoke_key_in_woocommerce: true } })
}
