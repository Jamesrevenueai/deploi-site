/**
 * The few Stripe API calls billing needs, over fetch (no SDK), plus webhook signature verification.
 * Every request goes to api.stripe.com only (lib/net/outbound.ts) with the secret key of this environment.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { assertApprovedHost } from '../net/outbound'
import { stripeConfig } from './config'

const API = 'https://api.stripe.com'

type Params = Record<string, unknown>

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

export class StripeError extends Error {
  constructor(public status: number, public type: string, message: string) { super(message); this.name = 'StripeError' }
}

export async function stripeRequest<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}, opts: { idempotencyKey?: string; fetchImpl?: typeof fetch; key?: string } = {}): Promise<T> {
  const key = opts.key ?? stripeConfig.secretKey
  if (!key) throw new StripeError(0, 'not_configured', 'Stripe is not configured (STRIPE_SECRET_KEY)')
  if (!/^\/v1\/[a-z_/]+[A-Za-z0-9_/]*$/.test(path)) throw new StripeError(0, 'invalid_path', 'invalid Stripe path')
  const body = formEncode(params)
  const url = method !== 'POST' && body ? `${API}${path}?${body}` : `${API}${path}`
  assertApprovedHost(url, 'stripe')
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, accept: 'application/json' }
  if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded'
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey
  const res = await (opts.fetchImpl ?? fetch)(url, { method, headers, body: method === 'POST' ? body : undefined })
  let json: Record<string, unknown> = {}
  try { json = await res.json() as Record<string, unknown> } catch { json = {} }
  if (!res.ok) {
    const err = (json.error ?? {}) as { type?: string; message?: string }
    throw new StripeError(res.status, err.type ?? 'api_error', `Stripe request failed (${res.status}): ${(err.message ?? '').slice(0, 200)}`)
  }
  return json as T
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
