/**
 * Shopify authentication primitives, all pure and unit-tested:
 *  - shop domain validation
 *  - HMAC verification of OAuth/install query strings and webhook bodies
 *  - session token (App Bridge id token) verification: HS256 JWT signed with the app secret
 *  - token exchange (embedded apps) and authorization-code exchange (non-embedded fallback)
 * Network calls go through the outbound boundary (shop host must be <name>.myshopify.com).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { assertApprovedHost } from '../../net/outbound'
import { shopifyConfig } from './config'

export const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

export function normalizeShop(input: string | null | undefined): string | null {
  if (!input) return null
  let s = input.trim().toLowerCase()
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!s.includes('.')) s = `${s}.myshopify.com`
  return SHOP_DOMAIN.test(s) ? s : null
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** OAuth / install redirect: hex HMAC-SHA256 over the sorted query string without `hmac` (and legacy `signature`). */
export function verifyQueryHmac(params: URLSearchParams | Record<string, string>, secret: string): boolean {
  const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params)
  const hmac = entries.find(([k]) => k === 'hmac')?.[1]
  if (!hmac || !secret) return false
  const message = entries.filter(([k]) => k !== 'hmac' && k !== 'signature').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&')
  const digest = createHmac('sha256', secret).update(message).digest('hex')
  return safeEqual(digest, hmac)
}

/** Webhooks: base64 HMAC-SHA256 of the raw request body, header X-Shopify-Hmac-Sha256. */
export function verifyWebhookHmac(rawBody: string | Buffer, header: string | null, secret: string): boolean {
  if (!header || !secret) return false
  const digest = createHmac('sha256', secret).update(rawBody).digest('base64')
  return safeEqual(digest, header)
}

export type SessionClaims = { iss: string; dest: string; aud: string; sub?: string; exp: number; nbf: number; iat: number; jti: string; sid?: string }
export type VerifiedSession = { shop: string; userId: string | null; sessionId: string | null; claims: SessionClaims }

const b64urlJson = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

/**
 * Verify an App Bridge session token. Rejects anything not HS256, a bad signature, an expired or
 * not-yet-valid token (small clock leeway), a wrong audience, or an issuer/destination that is not
 * the same *.myshopify.com shop.
 */
export function verifySessionToken(token: string, opts: { apiKey: string; apiSecret: string; now?: Date; leewaySec?: number }): VerifiedSession {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed session token')
  const [h, p, sig] = parts
  const header = b64urlJson(h) as { alg?: string; typ?: string }
  if (header.alg !== 'HS256') throw new Error('unexpected session token algorithm')
  const expected = createHmac('sha256', opts.apiSecret).update(`${h}.${p}`).digest('base64url')
  if (!safeEqual(expected, sig)) throw new Error('bad session token signature')
  const c = b64urlJson(p) as SessionClaims
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000)
  const leeway = opts.leewaySec ?? 5
  if (typeof c.exp !== 'number' || now > c.exp + leeway) throw new Error('session token expired')
  if (typeof c.nbf === 'number' && now + leeway < c.nbf) throw new Error('session token not yet valid')
  if (c.aud !== opts.apiKey) throw new Error('session token audience mismatch')
  const destHost = normalizeShop(c.dest)
  const issHost = normalizeShop(c.iss)
  if (!destHost || !issHost || destHost !== issHost) throw new Error('session token shop mismatch')
  return { shop: destHost, userId: c.sub ?? null, sessionId: c.sid ?? null, claims: c }
}

/** Create a session token (tests and the synthetic demo only). */
export function signSessionToken(claims: Partial<SessionClaims> & { dest: string }, secret: string, apiKey: string, now = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000)
  const body = { iss: `${claims.dest}/admin`, aud: apiKey, sub: '1', exp: iat + 60, nbf: iat, iat, jti: `jti-${iat}-${Math.random().toString(36).slice(2)}`, sid: 'sid-1', ...claims }
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const p = Buffer.from(JSON.stringify(body)).toString('base64url')
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`
}

export type AccessToken = { accessToken: string; scope: string[]; expiresIn: number | null; refreshToken: string | null; refreshTokenExpiresIn: number | null }

function parseTokenResponse(d: Record<string, unknown>): AccessToken {
  if (typeof d.access_token !== 'string') throw new Error('token response without access_token')
  return {
    accessToken: d.access_token,
    scope: String(d.scope ?? '').split(',').map(s => s.trim()).filter(Boolean),
    expiresIn: typeof d.expires_in === 'number' ? d.expires_in : null,
    refreshToken: typeof d.refresh_token === 'string' ? d.refresh_token : null,
    refreshTokenExpiresIn: typeof d.refresh_token_expires_in === 'number' ? d.refresh_token_expires_in : null,
  }
}

async function postToken(shop: string, body: Record<string, string>, fetchImpl: typeof fetch): Promise<AccessToken> {
  const url = `https://${shop}/admin/oauth/access_token`
  assertApprovedHost(url, 'shopify')
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`)
  return parseTokenResponse(await res.json() as Record<string, unknown>)
}

/** Embedded apps: exchange the App Bridge id token for an offline access token. */
/** Expiring offline tokens are mandatory for new public apps, so `expiring` defaults to true. */
export function exchangeSessionToken(shop: string, idToken: string, opts: { expiring?: boolean; fetchImpl?: typeof fetch } = {}): Promise<AccessToken> {
  return postToken(shop, {
    client_id: shopifyConfig.apiKey,
    client_secret: shopifyConfig.apiSecret,
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: idToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    ...(opts.expiring === false ? {} : { expiring: '1' }),
  }, opts.fetchImpl ?? fetch)
}

/** Non-embedded fallback: authorization code grant. */
export function exchangeAuthorizationCode(shop: string, code: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<AccessToken> {
  return postToken(shop, { client_id: shopifyConfig.apiKey, client_secret: shopifyConfig.apiSecret, code }, opts.fetchImpl ?? fetch)
}

/** Refresh an expiring offline token. */
export function refreshAccessToken(shop: string, refreshToken: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<AccessToken> {
  return postToken(shop, { client_id: shopifyConfig.apiKey, client_secret: shopifyConfig.apiSecret, grant_type: 'refresh_token', refresh_token: refreshToken }, opts.fetchImpl ?? fetch)
}

export function authorizeUrl(shop: string, state: string, redirectUri: string, scopes = shopifyConfig.scopes): string {
  const q = new URLSearchParams({ client_id: shopifyConfig.apiKey, scope: scopes.join(','), redirect_uri: redirectUri, state })
  return `https://${shop}/admin/oauth/authorize?${q.toString()}`
}
