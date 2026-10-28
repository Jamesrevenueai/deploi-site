/**
 * Admin GraphQL client. Real stores: https://<shop>/admin/api/<version>/graphql.json with the
 * decrypted offline token (outbound boundary enforced). Synthetic stores: the synthetic transport.
 * Reads retry on THROTTLED errors, HTTP 429 and 5xx with backoff. Mutations never auto-retry:
 * a lost mutation response is reported as unknown and settled by the engine's verification read.
 */
import { admin } from '../../db'
import { assertApprovedHost } from '../../net/outbound'
import { loadCredential, storeCredential } from '../credentials'
import { refreshAccessToken } from './auth'
import type { ConnectionRow } from '../../engine/types'
import { syntheticTransport } from './synthetic'
import { shopifyConfig } from './config'

export type GqlBody = { query: string; operationName: string; variables?: Record<string, unknown> }
export type Transport = (body: GqlBody) => Promise<{ status: number; json: unknown }>

export class ShopifyApiError extends Error {
  constructor(message: string, public kind: 'http' | 'graphql' | 'network' | 'throttled' | 'auth', public status?: number) { super(message); this.name = 'ShopifyApiError' }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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

/**
 * New public apps use expiring offline tokens (1 hour) with rotating refresh tokens (90 days).
 * Refresh under a row lock so two requests never spend the same refresh token.
 */
export async function currentAccessToken(conn: ConnectionRow, now = new Date()): Promise<string> {
  const cred = await admin(db => loadCredential(db, conn.id))
  if (!cred) throw new ShopifyApiError('no access token stored for this store', 'auth')
  const fresh = !cred.expiresAt || new Date(cred.expiresAt).getTime() - now.getTime() > 120_000
  if (fresh) return cred.secret
  return admin(async db => {
    await db.query('select id from store_credentials where connection_id = $1 for update', [conn.id])
    const again = await loadCredential(db, conn.id)
    if (again?.expiresAt && new Date(again.expiresAt).getTime() - Date.now() > 120_000) return again.secret
    if (!again?.refreshSecret) throw new ShopifyApiError('access token expired and no refresh token is stored; the merchant must reopen the app', 'auth')
    const t = await refreshAccessToken(conn.external_id, again.refreshSecret)
    await storeCredential(db, {
      connectionId: conn.id, orgId: conn.org_id, secret: t.accessToken, scopes: t.scope.length ? t.scope : again.scopes,
      expiresAt: t.expiresIn ? new Date(Date.now() + t.expiresIn * 1000) : null,
      refreshSecret: t.refreshToken, refreshExpiresAt: t.refreshTokenExpiresIn ? new Date(Date.now() + t.refreshTokenExpiresIn * 1000) : null,
      actor: 'system:token-refresh',
    })
    return t.accessToken
  })
}

type GqlResponse<T> = { data?: T; errors?: { message: string; extensions?: { code?: string } }[]; extensions?: unknown }

export async function shopifyGraphql<T>(conn: ConnectionRow, body: GqlBody, opts: { mutation?: boolean; maxAttempts?: number } = {}): Promise<T> {
  const transport = await transportFor(conn)
  const maxAttempts = opts.mutation ? 1 : opts.maxAttempts ?? 5
  for (let attempt = 1; ; attempt++) {
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
    if (json.errors?.length) {
      const throttled = json.errors.some(e => e.extensions?.code === 'THROTTLED')
      if (throttled && attempt < Math.max(maxAttempts, opts.mutation ? 3 : maxAttempts)) { await sleep(500 * attempt); continue }
      throw new ShopifyApiError(json.errors.map(e => e.message).join('; ').slice(0, 300), throttled ? 'throttled' : 'graphql')
    }
    if (!json.data) throw new ShopifyApiError('response without data', 'graphql')
    return json.data
  }
}
