/**
 * Authenticate a merchant API request. Two ways in:
 *  - Embedded Shopify admin: `Authorization: Bearer <App Bridge id token>`, verified with the app
 *    secret; the shop must have an active connection. Not CSRF-prone (no cookies).
 *  - The Deploi web app: the existing signed-in session cookie. State-changing requests must come
 *    from the app's own origin (CSRF check).
 * Staff sessions get a read-only staff actor.
 */
import { NextResponse } from 'next/server'
import { getSession } from '../auth'
import { admin } from '../db'
import { env } from '../env'
import { log } from '../log'
import { verifySessionToken, type VerifiedSession } from '../connectors/shopify/auth'
import { shopifyConfig } from '../connectors/shopify/config'
import type { Actor } from '../engine/actor'
import { isEngineError, type EngineErrorCode } from '../engine/errors'
import { isLibraryError, LIBRARY_STATUS } from '../library/errors'
import { hit } from '../security/rate-limit'
import '../connectors'

export class HttpError extends Error { constructor(public status: number, public code: string, message: string) { super(message); this.name = 'HttpError' } }
/** 429 with the seconds to wait (sent as Retry-After). */
export class RateLimitError extends HttpError { constructor(public retryAfterS: number) { super(429, 'rate_limited', 'too many requests; try again later'); this.name = 'RateLimitError' } }

/**
 * A generous per-organization ceiling on state-changing merchant calls (lib/security/rate-limit.ts,
 * bucket merchant_write; staff are keyed by user). Fails open if the database is unreachable.
 */
async function limitWrites(key: string) {
  const r = await hit('merchant_write', key)
  if (!r.allowed) throw new RateLimitError(r.retryAfterS)
}

/** Limit an authenticated operation per organization (staff: per user), e.g. bucket oauth_start for provider consent starts. */
export async function limitActor(bucket: 'oauth_start', actor: Actor) {
  const r = await hit(bucket, actor.kind === 'staff' ? `user:${actor.session.uid}` : `org:${actor.orgId}`)
  if (!r.allowed) throw new RateLimitError(r.retryAfterS)
}

export function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? ''
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : null
}

export function verifyShopifyBearer(req: Request): VerifiedSession | null {
  const token = bearer(req)
  if (!token) return null
  if (!shopifyConfig.configured) throw new HttpError(503, 'shopify_not_configured', 'Shopify app credentials are not configured')
  try { return verifySessionToken(token, { apiKey: shopifyConfig.apiKey, apiSecret: shopifyConfig.apiSecret }) } catch (e) {
    log.warn('shopify.session_token.rejected', { reason: (e as Error).message })
    throw new HttpError(401, 'invalid_session_token', 'session token rejected')
  }
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return req.headers.get('sec-fetch-site') === 'same-origin'
  const allowed = new Set([new URL(env.appUrl).origin, new URL(req.url).origin])
  return allowed.has(origin)
}

export async function resolveActor(req: Request, opts: { mutating?: boolean } = {}): Promise<Actor> {
  const shopSession = verifyShopifyBearer(req)
  if (shopSession) {
    const conn = await admin(db => db.one<{ org_id: string }>(`select org_id from store_connections where platform = 'shopify' and external_id = $1 and status = 'active'`, [shopSession.shop]))
    if (!conn) throw new HttpError(409, 'not_installed', 'this shop has not finished installing the app')
    if (opts.mutating) await limitWrites(`org:${conn.org_id}`)
    return { kind: 'shopify_user', orgId: conn.org_id, shop: shopSession.shop, userId: shopSession.userId ?? 'unknown', label: `shopify:${shopSession.shop}:user:${shopSession.userId ?? 'unknown'}` }
  }
  const s = await getSession()
  if (!s) throw new HttpError(401, 'unauthenticated', 'sign in required')
  if (opts.mutating && !sameOrigin(req)) throw new HttpError(403, 'bad_origin', 'cross-site request refused')
  if (s.role === 'staff') {
    if (opts.mutating) await limitWrites(`user:${s.uid}`)
    return { kind: 'staff', session: s, label: `staff:${s.email}` }
  }
  if (s.orgType !== 'merchant' || !s.agencyId) throw new HttpError(403, 'not_a_merchant', 'this account is not linked to a store organization')
  // viewers are read-only: every state-changing call is refused (lib/platform/rbac.ts; the role is re-read from the profile on every request)
  if (opts.mutating && s.orgRole === 'viewer') throw new HttpError(403, 'read_only_role', 'your role (viewer) is read-only; ask an owner or admin')
  if (opts.mutating) await limitWrites(`org:${s.agencyId}`)
  return { kind: 'profile', session: s, orgId: s.agencyId, label: `user:${s.email}` }
}

const ENGINE_STATUS: Record<EngineErrorCode, number> = {
  not_found: 404, forbidden: 403, invalid_input: 400,
  not_pending: 409, expired: 409, hash_mismatch: 409, rule_changed: 409, not_retryable: 409, connection_inactive: 409, not_operational: 409, agent_inactive: 409, busy: 409, too_many_attempts: 429,
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof HttpError) {
    // App Bridge fetches a fresh ID token and retries once when it sees this header on a 401
    const headers: Record<string, string> | undefined = e instanceof RateLimitError ? { 'Retry-After': String(e.retryAfterS), 'cache-control': 'no-store' }
      : e.code === 'invalid_session_token' ? { 'X-Shopify-Retry-Invalid-Session-Request': '1' } : undefined
    return NextResponse.json({ ok: false, error: e.code, message: e.message }, { status: e.status, headers })
  }
  if (isEngineError(e)) return NextResponse.json({ ok: false, error: e.code, message: e.message }, { status: ENGINE_STATUS[e.code] ?? 400 })
  if (isLibraryError(e)) return NextResponse.json({ ok: false, error: e.code, message: e.message, detail: e.detail }, { status: LIBRARY_STATUS[e.code] ?? 400 })
  log.error('store.api.failed', { error: (e as Error).message })
  return NextResponse.json({ ok: false, error: 'internal', message: 'something went wrong' }, { status: 500 })
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try { const j = await req.json(); return j && typeof j === 'object' ? j as Record<string, unknown> : {} } catch { throw new HttpError(400, 'invalid_json', 'request body must be JSON') }
}

/** Client IP from the request (proxy headers), for the audit trail. */
export function ipOf(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null
}
