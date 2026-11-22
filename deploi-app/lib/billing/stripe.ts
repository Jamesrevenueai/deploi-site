/**
 * The Stripe API over fetch (no SDK), plus webhook signature verification.
 *
 *  - API version pinned with the `Stripe-Version` header (STRIPE_API_VERSION below), so a change to the
 *    account's default version in the Stripe dashboard never changes the shapes this code reads.
 *  - Every POST carries an `Idempotency-Key` (the caller's deterministic key, or a random one), and the same
 *    key is reused on every retry, so a retried POST can never create a second object.
 *  - Retries: network failures, 429 and 5xx (and whatever Stripe marks `Stripe-Should-Retry: true`), never a
 *    request Stripe marks `Stripe-Should-Retry: false`; exponential backoff with jitter, at most
 *    STRIPE_MAX_RETRIES (default 2) retries.
 *  - Errors are mapped to a small set of kinds (card_error, rate_limit, api_error, invalid_request,
 *    authentication, idempotency, network) that the API turns into honest messages (stripeHttpError).
 *  - Requests go to api.stripe.com only (lib/net/outbound.ts). STRIPE_API_BASE may point at a local fake
 *    Stripe (http://127.0.0.1:<port>), and only while BILLING_MODE=test outside production: the end-to-end
 *    tests use it; nothing else can redirect billing traffic.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { assertApprovedHost } from '../net/outbound'
import { isProductionDeployment } from '../auth-guard'
import { billingMode, stripeConfig } from './config'

const API = 'https://api.stripe.com'
/** The Stripe API version every request is made with (subscription items carry the period; invoice previews are create_preview). */
export const STRIPE_API_VERSION = '2025-03-31.basil'

type Params = Record<string, unknown>
type Env = Record<string, string | undefined>

/** The base URL of the Stripe API: api.stripe.com, or a loopback fake in test mode outside production. */
export function stripeApiBase(e: Env = process.env): string {
  const raw = (e.STRIPE_API_BASE ?? '').trim().replace(/\/$/, '')
  if (!raw || billingMode(e) !== 'test' || isProductionDeployment(e)) return API
  return /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(raw) ? raw : API
}

/** Stripe's form encoding: nested objects as a[b]=, arrays as a[0]=. Undefined and null are left out. */
export function formEncode(params: Params, prefix = ''): string {
  const parts: string[] = []
  const add = (k: string, val: unknown) => {
    if (val === undefined || val === null) return
    if (Array.isArray(val)) val.forEach((x, i) => add(`${k}[${i}]`, x))
    else if (typeof val === 'object') for (const [ck, cv] of Object.entries(val as Params)) add(`${k}[${ck}]`, cv)
    else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(val))}`)
  }
  for (const [k, val] of Object.entries(params)) add(prefix ? `${prefix}[${k}]` : k, val)
  return parts.join('&')
}

export type StripeErrorKind = 'card_error' | 'rate_limit' | 'api_error' | 'invalid_request' | 'authentication' | 'idempotency' | 'network' | 'not_configured'

export class StripeError extends Error {
  constructor(public status: number, public type: string, message: string, public kind: StripeErrorKind = 'api_error', public code: string | null = null, public declineCode: string | null = null) {
    super(message); this.name = 'StripeError'
  }
}

/** Stripe's error object -> one of our kinds (https://docs.stripe.com/error-handling). */
export function stripeErrorKind(status: number, type: string | undefined, code?: string | null): StripeErrorKind {
  if (type === 'card_error') return 'card_error'
  if (status === 429 || code === 'rate_limit') return 'rate_limit'
  if (type === 'idempotency_error') return 'idempotency'
  if (status === 401 || type === 'authentication_error') return 'authentication'
  if (status >= 500 || type === 'api_error') return 'api_error'
  return 'invalid_request'
}

export type StripeRequestOpts = { idempotencyKey?: string; fetchImpl?: typeof fetch; key?: string; maxRetries?: number; sleep?: (ms: number) => Promise<void> }

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
function maxRetries(): number { const n = Number((process.env.STRIPE_MAX_RETRIES ?? '').trim()); return Number.isInteger(n) && n >= 0 && n <= 5 && (process.env.STRIPE_MAX_RETRIES ?? '').trim() !== '' ? n : 2 }
/** Backoff before retry n (1-based): 500 ms doubling, capped at 5 s, with up to 25% jitter. */
export function retryDelayMs(n: number, rand = Math.random()): number { const base = Math.min(5000, 500 * 2 ** (n - 1)); return Math.round(base * (0.75 + 0.25 * rand)) }

export async function stripeRequest<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}, opts: StripeRequestOpts = {}): Promise<T> {
  const key = opts.key ?? stripeConfig.secretKey
  if (!key) throw new StripeError(0, 'not_configured', 'Stripe is not configured (STRIPE_SECRET_KEY)', 'not_configured')
  if (!/^\/v1\/[a-z_/]+[A-Za-z0-9_/]*$/.test(path)) throw new StripeError(0, 'invalid_path', 'invalid Stripe path', 'invalid_request')
  const body = formEncode(params)
  const base = stripeApiBase()
  const url = method !== 'POST' && body ? `${base}${path}?${body}` : `${base}${path}`
  if (base === API) assertApprovedHost(url, 'stripe')
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, accept: 'application/json', 'stripe-version': STRIPE_API_VERSION }
  if (method === 'POST') {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    headers['idempotency-key'] = opts.idempotencyKey ?? `deploi-${randomUUID()}`
  } else if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey
  const retries = opts.maxRetries ?? maxRetries()
  const sleep = opts.sleep ?? defaultSleep
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await (opts.fetchImpl ?? fetch)(url, { method, headers, body: method === 'POST' ? body : undefined })
    } catch (e) {
      if (attempt < retries) { await sleep(retryDelayMs(attempt + 1)); continue }
      throw new StripeError(0, 'network', `Stripe could not be reached: ${(e as Error).message.slice(0, 120)}`, 'network')
    }
    let json: Record<string, unknown> = {}
    try { json = await res.json() as Record<string, unknown> } catch { json = {} }
    if (res.ok) return json as T
    const should = res.headers.get('stripe-should-retry')
    const retryable = should === 'true' || (should !== 'false' && (res.status === 429 || res.status >= 500))
    if (retryable && attempt < retries) { await sleep(retryDelayMs(attempt + 1)); continue }
    const err = (json.error ?? {}) as { type?: string; message?: string; code?: string; decline_code?: string }
    const kind = stripeErrorKind(res.status, err.type, err.code)
    throw new StripeError(res.status, err.type ?? 'api_error', `Stripe request failed (${res.status}): ${(err.message ?? '').slice(0, 200)}`, kind, err.code ?? null, err.decline_code ?? null)
  }
}

/** A message the owner can act on for a Stripe failure (card messages are Stripe's own, which it marks safe to show). */
export function stripeFailureMessage(e: StripeError): { status: number; code: string; message: string } {
  switch (e.kind) {
    case 'card_error': return { status: 402, code: 'card_declined', message: `The card was declined${e.declineCode ? ` (${e.declineCode.replace(/_/g, ' ')})` : ''}: update the payment method in the billing portal` }
    case 'rate_limit': return { status: 503, code: 'stripe_busy', message: 'Stripe is busy right now; nothing was changed. Try again in a minute.' }
    case 'network': case 'api_error': return { status: 502, code: 'stripe_unavailable', message: 'Stripe did not respond; nothing was confirmed. Try again in a minute.' }
    case 'authentication': case 'not_configured': return { status: 503, code: 'billing_not_configured', message: 'billing is not configured in this environment' }
    case 'idempotency': return { status: 409, code: 'stripe_conflict', message: 'the same request is already being processed; reload in a moment' }
    default: return { status: 502, code: 'stripe_error', message: 'Stripe refused the request; nothing was changed' }
  }
}

// ---------------------------------------------------------------- webhook signatures

export const SIGNATURE_TOLERANCE_SEC = 300

export type SignatureCheck = { ok: true; timestamp: number } | { ok: false; reason: 'missing_header' | 'malformed_header' | 'outside_tolerance' | 'no_match' | 'no_secret' }

/**
 * Verify a `Stripe-Signature` header: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`,
 * possibly several v1 entries (during secret rotation). The timestamp must be within the tolerance
 * either way; comparison is constant-time. The raw body must be the exact bytes Stripe sent.
 */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, opts: { toleranceSec?: number; nowSec?: number } = {}): SignatureCheck {
  if (!secret) return { ok: false, reason: 'no_secret' }
  if (!header) return { ok: false, reason: 'missing_header' }
  let t: number | null = null
  const v1: string[] = []
  for (const part of header.split(',')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const k = part.slice(0, i).trim(), val = part.slice(i + 1).trim()
    if (k === 't' && /^\d{1,12}$/.test(val)) t = Number(val)
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(val)) v1.push(val.toLowerCase())
  }
  if (t === null || !v1.length) return { ok: false, reason: 'malformed_header' }
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - t) > (opts.toleranceSec ?? SIGNATURE_TOLERANCE_SEC)) return { ok: false, reason: 'outside_tolerance' }
  const want = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex'), 'utf8')
  const match = v1.some(sig => { const got = Buffer.from(sig, 'utf8'); return got.length === want.length && timingSafeEqual(got, want) })
  return match ? { ok: true, timestamp: t } : { ok: false, reason: 'no_match' }
}

/** Build a valid header (tests and local tooling only; never used to accept a request). */
export function signStripePayload(rawBody: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): string {
  return `t=${nowSec},v1=${createHmac('sha256', secret).update(`${nowSec}.${rawBody}`, 'utf8').digest('hex')}`
}
