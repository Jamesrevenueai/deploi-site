/**
 * Admin GraphQL client. Real stores: https://<shop>/admin/api/<version>/graphql.json with the
 * decrypted offline token (outbound boundary enforced). Synthetic stores: the synthetic transport.
 * Reads retry on THROTTLED errors, HTTP 429 and 5xx with backoff. Mutations never auto-retry:
 * a lost mutation response is reported as unknown and settled by the engine's verification read.
 */
import { admin, type Db } from '../../db'
import { audit } from '../../engine/audit'
import { assertApprovedHost } from '../../net/outbound'
import { loadCredential, storeCredential, deleteCredential } from '../credentials'
import { refreshAccessToken, TokenRequestError, type AccessToken } from './auth'
import type { ConnectionRow } from '../../engine/types'
import { syntheticTransport } from './synthetic'
import { shopifyConfig } from './config'

export type GqlBody = { query: string; operationName: string; variables?: Record<string, unknown> }
export type Transport = (body: GqlBody) => Promise<{ status: number; json: unknown }>

export class ShopifyApiError extends Error {
  constructor(message: string, public kind: 'http' | 'graphql' | 'network' | 'throttled' | 'auth', public status?: number) { super(message); this.name = 'ShopifyApiError' }
}

let sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
/** Tests only: replace the wait between retries. */
export function setSleep(fn: ((ms: number) => Promise<void>) | null) { sleep = fn ?? (ms => new Promise<void>(r => setTimeout(r, ms))) }

let transportOverride: ((conn: ConnectionRow) => Transport) | null = null
/** Tests only: route real-connection traffic to a stub. */
export function setTransportOverride(fn: ((conn: ConnectionRow) => Transport) | null) { transportOverride = fn }

export function realTransport(shop: string, token: string, version = shopifyConfig.apiVersion, fetchImpl: typeof fetch = fetch): Transport {
  const url = `https://${shop}/admin/api/${version}/graphql.json`
  assertApprovedHost(url, 'shopify')
  return async body => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': token }, body: JSON.stringify(body) })
    const json = await res.json().catch(() => null)
    return { status: res.status, json }
  }
}

async function transportFor(conn: ConnectionRow): Promise<Transport> {
  if (transportOverride) return transportOverride(conn)
  if (conn.is_synthetic) return syntheticTransport(conn.id)
  const token = await currentAccessToken(conn)
  return realTransport(conn.external_id, token, conn.api_version || shopifyConfig.apiVersion)
}

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 120_000

/**
 * Mark a connection as needing the merchant to reopen the app (fail closed): status 'error' stops scans,
 * agent runs and writes; the stored credential is deleted so nothing can use it. The next verified app
 * open runs token exchange again (install.ts#ensureInstalled), which clears the state.
 */
export async function markNeedsReauth(db: Db, conn: Pick<ConnectionRow, 'id' | 'org_id'>, reason: string, actor = 'system:token-refresh') {
  await deleteCredential(db, conn.id, conn.org_id, actor, reason)
  const r = await db.query(`update store_connections set status = 'error', status_reason = $2, reauth_required_at = now() where id = $1 and status = 'active' returning id`, [conn.id, `needs_reauth: ${reason}`])
  if (r.length) await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'connection', entityId: conn.id, event: 'connection.needs_reauth', actor, detail: { reason } })
}

const REAUTH_MESSAGE = 'the store connection needs to be renewed: open Deploi from the Shopify admin'

/**
 * New public apps use expiring offline tokens (1 hour) with rotating refresh tokens (90 days).
 * Refresh under a row lock so two requests never spend the same refresh token. Every failure is
 * closed: no request is sent with an expired token. A refused or expired refresh token marks the
 * connection as needing reauthorization; a temporary failure (429, 5xx, network) is retried later.
 */
export async function currentAccessToken(conn: ConnectionRow, now = new Date(), fetchImpl?: typeof fetch): Promise<string> {
  const cred = await admin(db => loadCredential(db, conn.id))
  if (!cred) throw new ShopifyApiError('no access token stored for this store; the merchant must reopen the app', 'auth')
  const fresh = !cred.expiresAt || new Date(cred.expiresAt).getTime() - now.getTime() > REFRESH_MARGIN_MS
  if (fresh) return cred.secret
  const r = await admin(async db => {
    await db.query('select id from store_credentials where connection_id = $1 for update', [conn.id])
    const again = await loadCredential(db, conn.id)
    if (!again) return { kind: 'reauth' as const }
    if (again.expiresAt && new Date(again.expiresAt).getTime() - now.getTime() > REFRESH_MARGIN_MS) return { kind: 'ok' as const, token: again.secret }
    if (!again.refreshSecret) { await markNeedsReauth(db, conn, 'access token expired and no refresh token is stored'); return { kind: 'reauth' as const } }
    if (again.refreshExpiresAt && new Date(again.refreshExpiresAt).getTime() <= now.getTime()) { await markNeedsReauth(db, conn, 'the refresh token expired'); return { kind: 'reauth' as const } }
    let t: AccessToken
    try { t = await refreshAccessToken(conn.external_id, again.refreshSecret, fetchImpl ? { fetchImpl } : {}) } catch (e) {
      if (e instanceof TokenRequestError && e.terminal) {
        // a refused refresh token is final: committed (not thrown), so the next app open re-runs token exchange
        await markNeedsReauth(db, conn, `refresh refused (HTTP ${e.status})`)
        return { kind: 'reauth' as const }
      }
      return { kind: 'retry' as const, error: (e as Error).message.slice(0, 160) }
    }
    // rotation: the response carries a new refresh token; the old one must not be used again
    await storeCredential(db, {
      connectionId: conn.id, orgId: conn.org_id, secret: t.accessToken, scopes: t.scope.length ? t.scope : again.scopes,
      expiresAt: t.expiresIn ? new Date(now.getTime() + t.expiresIn * 1000) : null,
      refreshSecret: t.refreshToken ?? again.refreshSecret,
      refreshExpiresAt: t.refreshToken ? (t.refreshTokenExpiresIn ? new Date(now.getTime() + t.refreshTokenExpiresIn * 1000) : null) : (again.refreshExpiresAt ? new Date(again.refreshExpiresAt) : null),
      actor: 'system:token-refresh',
    })
    if (t.scope.length && [...t.scope].sort().join(',') !== [...conn.scopes].sort().join(',')) await db.query('update store_connections set scopes = $2 where id = $1', [conn.id, [...new Set(t.scope)].sort()])
    return { kind: 'ok' as const, token: t.accessToken }
  })
  if (r.kind === 'reauth') throw new ShopifyApiError(REAUTH_MESSAGE, 'auth')
  if (r.kind === 'retry') throw new ShopifyApiError(`could not refresh the access token (${r.error}); nothing was sent`, 'network')
  return r.token
}

/** extensions.cost as Shopify returns it on every Admin GraphQL response. */
export type QueryCost = { requestedQueryCost?: number; actualQueryCost?: number | null; throttleStatus?: { maximumAvailable?: number; currentlyAvailable?: number; restoreRate?: number } }

/**
 * How long to wait before a request that needs `needed` points, given the last throttle status:
 * the deficit divided by the restore rate. Bounded so a bad value never stalls a run.
 */
export function throttleWaitMs(cost: QueryCost | null | undefined, needed?: number): number {
  const t = cost?.throttleStatus
  if (!t || typeof t.currentlyAvailable !== 'number' || typeof t.restoreRate !== 'number' || t.restoreRate <= 0) return 0
  const want = needed ?? cost?.requestedQueryCost ?? 0
  const deficit = want - t.currentlyAvailable
  if (deficit <= 0) return 0
  return Math.min(10_000, Math.max(250, Math.ceil((deficit / t.restoreRate) * 1000)))
}

/** The last throttle status per connection, so the next request waits instead of being refused. */
const bucket = new Map<string, { cost: QueryCost; at: number }>()

/** Wait time before the next request on this connection (the bucket refills at restoreRate per second). */
export function pacingWaitMs(connectionId: string, now = Date.now()): number {
  const b = bucket.get(connectionId)
  const t = b?.cost.throttleStatus
  if (!b || !t || typeof t.currentlyAvailable !== 'number' || typeof t.restoreRate !== 'number') return 0
  const refilled = Math.min(t.maximumAvailable ?? Infinity, t.currentlyAvailable + ((now - b.at) / 1000) * t.restoreRate)
  return throttleWaitMs({ ...b.cost, throttleStatus: { ...t, currentlyAvailable: refilled } }, b.cost.requestedQueryCost)
}

type GqlResponse<T> = { data?: T; errors?: { message: string; extensions?: { code?: string } }[]; extensions?: { cost?: QueryCost } }

/**
 * One Admin GraphQL call. Reads retry on network errors, HTTP 429/5xx and THROTTLED with backoff;
 * a THROTTLED response means the operation did not run, so a mutation may be retried on it (and only on
 * it). The wait comes from extensions.cost.throttleStatus when Shopify sends it, and the last status is
 * kept per connection so the next request waits for the bucket instead of being refused.
 */
export async function shopifyGraphql<T>(conn: ConnectionRow, body: GqlBody, opts: { mutation?: boolean; maxAttempts?: number } = {}): Promise<T> {
  const transport = await transportFor(conn)
  const maxAttempts = opts.mutation ? 1 : opts.maxAttempts ?? 5
  const throttleAttempts = opts.mutation ? 3 : maxAttempts
  for (let attempt = 1; ; attempt++) {
    const pace = pacingWaitMs(conn.id)
    if (pace > 0) await sleep(pace)
    let res: { status: number; json: unknown }
    try {
      res = await transport(body)
    } catch (e) {
      if (!opts.mutation && attempt < maxAttempts) { await sleep(200 * 2 ** attempt); continue }
      throw new ShopifyApiError((e as Error).message, 'network')
    }
    if (res.status === 401 || res.status === 403) throw new ShopifyApiError(`HTTP ${res.status}: access denied`, 'auth', res.status)
    if (res.status === 429 || res.status >= 500) {
      if (!opts.mutation && attempt < maxAttempts) { await sleep(300 * 2 ** attempt); continue }
      throw new ShopifyApiError(`HTTP ${res.status}`, res.status === 429 ? 'throttled' : 'http', res.status)
    }
    const json = res.json as GqlResponse<T> | null
    if (!json) throw new ShopifyApiError('empty response', 'http', res.status)
    const cost = json.extensions?.cost
    if (cost?.throttleStatus) bucket.set(conn.id, { cost, at: Date.now() })
    if (json.errors?.length) {
      const throttled = json.errors.some(e => e.extensions?.code === 'THROTTLED')
      if (throttled && attempt < throttleAttempts) { await sleep(throttleWaitMs(cost) || 500 * attempt); continue }
      const denied = json.errors.some(e => e.extensions?.code === 'ACCESS_DENIED')
      throw new ShopifyApiError(json.errors.map(e => e.message).join('; ').slice(0, 300), throttled ? 'throttled' : denied ? 'auth' : 'graphql')
    }
    if (!json.data) throw new ShopifyApiError('response without data', 'graphql')
    return json.data
  }
}
