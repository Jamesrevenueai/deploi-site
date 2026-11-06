/**
 * Rate limits backed by Postgres (migration 44, `rate_limits`). Vercel functions keep no memory between
 * requests and there is no Redis, so every check is one statement: `rate_limit_hit()` increments the
 * counter for (bucket, key, current fixed window) atomically and returns it with the previous window's
 * count. The decision uses the sliding-window estimate
 *     previous * (1 - elapsed / window) + current
 * which smooths the burst a fixed window allows at its boundary. Every attempt counts, refused ones too,
 * so a client that keeps hammering stays refused. Concurrent hits on one key see the counts 1..N, so no
 * more than `limit` of N parallel requests are ever allowed.
 *
 * Keys. Client IP: the first hop of `x-forwarded-for`, else `x-real-ip`. On Vercel both are set by
 * Vercel's edge from the TCP connection and a client-supplied value is overwritten, so they cannot be
 * spoofed there. Behind another proxy (or self-hosted with no proxy) they are only as trustworthy as that
 * proxy; a request with neither header shares the key `ip:unknown`. IPv6 addresses are keyed by their
 * /64 (one subscriber usually holds a whole /64). Authenticated routes key by organization (or user) id.
 *
 * Failure. Every bucket below declares what happens when the database cannot be reached. All of them
 * fail open (allow, log `rate_limit.unavailable`): each guarded request needs the same database to do
 * its work, so with the database down it fails anyway, and refusing would only add a second error.
 *
 * Configuration: `RATE_LIMIT_<BUCKET>=<limit>/<window seconds>` (e.g. `RATE_LIMIT_LEAD=6/600`) overrides
 * a default; `RATE_LIMITS=off` disables every limit (for load tests; never set it in production).
 */
import { NextResponse } from 'next/server'
import { getPool } from '../db'
import { log } from '../log'

export type BucketName =
  | 'lead' | 'magic_link_ip' | 'magic_link_email' | 'dev_login' | 'auth_callback'
  | 'oauth_start' | 'oauth_callback' | 'unsubscribe' | 'woo_callback' | 'merchant_write' | 'webhook_invalid' | 'contact'

export type BucketConfig = { limit: number; windowS: number; onError: 'open' | 'closed'; why: string }

/** Defaults. The e2e suite runs under them unchanged (one IP: ~60 dev sign-ins and at most ~35 writes a minute per organization per run). */
export const BUCKETS: Record<BucketName, BucketConfig> = {
  lead: { limit: 6, windowS: 600, onError: 'open', why: 'public early-access form, per IP (a person applies once)' },
  magic_link_ip: { limit: 10, windowS: 900, onError: 'open', why: 'sign-in link requests per IP (Supabase also limits OTP mail)' },
  magic_link_email: { limit: 5, windowS: 3600, onError: 'open', why: 'sign-in link requests per address, so one inbox cannot be flooded from many IPs' },
  dev_login: { limit: 300, windowS: 600, onError: 'open', why: 'development sign-in (AUTH_MODE=dev only), per IP' },
  auth_callback: { limit: 30, windowS: 600, onError: 'open', why: 'magic-link code exchange, per IP' },
  oauth_start: { limit: 30, windowS: 600, onError: 'open', why: 'OAuth starts (Shopify install per IP; mailbox and Office consent per organization)' },
  oauth_callback: { limit: 60, windowS: 600, onError: 'open', why: 'OAuth callbacks, per IP' },
  unsubscribe: { limit: 30, windowS: 600, onError: 'open', why: 'one-click unsubscribe, per IP' },
  woo_callback: { limit: 30, windowS: 600, onError: 'open', why: 'WooCommerce key callback (server to server), per IP' },
  merchant_write: { limit: 600, windowS: 60, onError: 'open', why: 'state-changing merchant API calls, per organization (staff: per user)' },
  webhook_invalid: { limit: 120, windowS: 600, onError: 'open', why: 'webhook deliveries that FAILED signature verification, per IP; valid deliveries are never counted or refused' },
  contact: { limit: 5, windowS: 600, onError: 'open', why: 'public website contact form, per IP (each message notifies staff by email)' },
}

export function bucketConfig(name: BucketName, env: Record<string, string | undefined> = process.env): BucketConfig {
  const base = BUCKETS[name]
  const raw = (env[`RATE_LIMIT_${name.toUpperCase()}`] ?? '').trim()
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(raw)
  if (!m) return base
  const limit = Number(m[1]), windowS = Number(m[2])
  if (limit < 1 || windowS < 1 || windowS > 86400) return base
  return { ...base, limit, windowS }
}

export const limitsDisabled = (env: Record<string, string | undefined> = process.env) => (env.RATE_LIMITS ?? '').trim().toLowerCase() === 'off'

export type LimitResult = { allowed: boolean; limit: number; remaining: number; retryAfterS: number; degraded?: boolean }

/** Seconds until one more hit would be allowed, from the sliding estimate (at least 1, at most the rest of the window plus one window). */
export function retryAfter(limit: number, windowS: number, hits: number, prevHits: number, elapsedMs: number): number {
  const W = windowS * 1000
  const restOfWindow = Math.max(0, W - elapsedMs)
  // the current window alone is at the limit: wait for the next window, where it becomes the "previous"
  // window weighted (1 - e/W); find e with hits * (1 - e/W) + 1 <= limit
  if (hits + 1 > limit) {
    const e = hits > 0 ? W * Math.max(0, 1 - (limit - 1) / hits) : 0
    return Math.max(1, Math.ceil(Math.round(restOfWindow + e) / 1000))
  }
  // otherwise the previous window's weight has to drop: prev * (1 - e/W) + hits + 1 <= limit
  const e = prevHits > 0 ? W * (1 - (limit - hits - 1) / prevHits) : 0
  return Math.max(1, Math.min(Math.ceil(restOfWindow / 1000), Math.ceil(Math.round(e - elapsedMs) / 1000)))
}

export function decide(limit: number, windowS: number, hits: number, prevHits: number, elapsedMs: number): LimitResult {
  const weight = Math.max(0, 1 - elapsedMs / (windowS * 1000))
  const estimate = prevHits * weight + hits
  const allowed = estimate <= limit
  return { allowed, limit, remaining: Math.max(0, Math.floor(limit - estimate)), retryAfterS: allowed ? 0 : retryAfter(limit, windowS, hits, prevHits, elapsedMs) }
}

let lastCleanup = 0

/**
 * Count a hit for `key` in `bucket` and decide. `at` (tests only) fixes the clock inside the database.
 * Options `limit`/`windowS` override the configured bucket (tests).
 */
export async function hit(bucket: BucketName, key: string, opts: { cost?: number; at?: Date; limit?: number; windowS?: number } = {}): Promise<LimitResult> {
  const cfg = bucketConfig(bucket)
  const limit = opts.limit ?? cfg.limit, windowS = opts.windowS ?? cfg.windowS
  if (limitsDisabled()) return { allowed: true, limit, remaining: limit, retryAfterS: 0 }
  const k = key.slice(0, 200) || 'unknown'
  try {
    const r = await getPool().query<{ hits: number; prev_hits: number; elapsed_ms: number }>(
      'select hits, prev_hits, elapsed_ms from rate_limit_hit($1, $2, $3, $4, $5)', [bucket, k, windowS, opts.cost ?? 1, opts.at ?? null])
    const row = r.rows[0]
    const out = decide(limit, windowS, Number(row.hits), Number(row.prev_hits), Number(row.elapsed_ms))
    // log the first refusal of a run, not every refused hit of a flood
    if (!out.allowed && decide(limit, windowS, Number(row.hits) - 1, Number(row.prev_hits), Number(row.elapsed_ms)).allowed) log.warn('rate_limit.exceeded', { bucket, limit, window_s: windowS })
    maybeCleanup()
    return out
  } catch (e) {
    log.error('rate_limit.unavailable', { bucket, error: (e as Error).message.slice(0, 160) })
    return { allowed: cfg.onError === 'open', limit, remaining: 0, retryAfterS: cfg.onError === 'open' ? 0 : 60, degraded: true }
  }
}

/** Delete expired windows at most once a minute per function instance, after the response path's query. */
function maybeCleanup() {
  const now = Date.now()
  if (now - lastCleanup < 60_000) return
  lastCleanup = now
  getPool().query('select rate_limits_cleanup(5000)').catch(e => log.warn('rate_limit.cleanup_failed', { error: (e as Error).message.slice(0, 120) }))
}

export async function cleanupRateLimits(): Promise<number> {
  const r = await getPool().query<{ n: number }>('select rate_limits_cleanup(50000) as n')
  return Number(r.rows[0]?.n ?? 0)
}

/** IPv6 addresses are reduced to their /64; IPv4 (and IPv4-mapped IPv6) stay whole. */
export function normalizeIp(ip: string): string {
  const s = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase()
  if (!s.includes(':')) return s
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (mapped) return mapped[1]
  const [head, tail = ''] = s.split('::')
  const h = head ? head.split(':') : []
  const t = s.includes('::') ? (tail ? tail.split(':') : []) : []
  const groups = s.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return s.slice(0, 64)
  return `${groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/** The client IP as Vercel reports it (see the header comment for when this can be trusted). */
export function clientIp(headers: Headers): string | null {
  const ip = headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip')?.trim() || ''
  return ip ? normalizeIp(ip) : null
}

export const ipKey = (headers: Headers) => `ip:${clientIp(headers) ?? 'unknown'}`

/** Count a hit keyed by the request's client IP. */
export function hitByIp(bucket: BucketName, req: Request | { headers: Headers }, opts: { cost?: number } = {}): Promise<LimitResult> {
  return hit(bucket, ipKey(req.headers), opts)
}

export function tooManyRequests(r: LimitResult, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ ok: false, error: 'rate_limited', message: 'too many requests; try again later', retryAfter: r.retryAfterS }, {
    status: 429,
    headers: { ...headers, 'Retry-After': String(r.retryAfterS), 'RateLimit-Limit': String(r.limit), 'RateLimit-Remaining': '0', 'cache-control': 'no-store' },
  })
}

/**
 * Webhooks: valid deliveries are never counted or refused (providers retry, and a dropped delivery is
 * lost work). Only a delivery the handler REJECTED for its signature (401/403) is counted against the
 * sender's IP; past the ceiling the rejection becomes a 429 so a flood of forged posts is answered
 * cheaply. Pass the handler's own response (and `rejected` when its status alone does not say so).
 */
export async function limitRejectedWebhook(req: Request, res: Response, rejected = res.status === 401 || res.status === 403): Promise<Response> {
  if (!rejected) return res
  const r = await hitByIp('webhook_invalid', req)
  return r.allowed ? res : tooManyRequests(r)
}
