/**
 * The Stripe client: pinned API version, an idempotency key on every POST (kept across retries), retries on
 * 429 and 5xx with backoff (never when Stripe says not to), error mapping, and the test-only local base URL.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { stripeRequest, stripeApiBase, StripeError, stripeErrorKind, stripeFailureMessage, retryDelayMs, STRIPE_API_VERSION } from '../../lib/billing/stripe'
import { viaStripe } from '../../lib/billing/checkout'
import { FakeStripe } from './fake-stripe'

const KEY = ['sk', 'test', 'clientnotreal'].join('_')
const saved: Record<string, string | undefined> = {}
const ENV = { BILLING_MODE: 'test', STRIPE_SECRET_KEY: KEY, STRIPE_MAX_RETRIES: '' }
beforeEach(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v } delete process.env.STRIPE_API_BASE })
afterEach(() => { for (const k of [...Object.keys(ENV), 'STRIPE_API_BASE', 'DEPLOI_ENV']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

const noSleep = { waits: [] as number[], sleep(ms: number) { noSleep.waits.push(ms); return Promise.resolve() } }

describe('Stripe client', () => {
  it('pins the API version and sends an idempotency key on every POST (generated when the caller gives none)', async () => {
    const f = new FakeStripe()
    await stripeRequest('POST', '/v1/customers', { name: 'A' }, { fetchImpl: f.fetch })
    await stripeRequest('POST', '/v1/customers', { name: 'B' }, { fetchImpl: f.fetch, idempotencyKey: 'deploi-customer-x' })
    await stripeRequest('GET', '/v1/invoices', { customer: 'cus_1', limit: 3 }, { fetchImpl: f.fetch })
    expect(f.calls.map(c => c.headers['stripe-version'])).toEqual([STRIPE_API_VERSION, STRIPE_API_VERSION, STRIPE_API_VERSION])
    expect(STRIPE_API_VERSION).toBe('2025-03-31.basil')
    expect(f.calls[0].headers['idempotency-key']).toMatch(/^deploi-[0-9a-f-]{36}$/)
    expect(f.calls[1].headers['idempotency-key']).toBe('deploi-customer-x')
    expect(f.calls[2].headers['idempotency-key']).toBeUndefined()
    expect(f.calls[2].params.get('limit')).toBe('3')
    // the same key with other parameters is Stripe's idempotency_error, mapped as such
    await expect(stripeRequest('POST', '/v1/customers', { name: 'C' }, { fetchImpl: f.fetch, idempotencyKey: 'deploi-customer-x' })).rejects.toMatchObject({ kind: 'idempotency', status: 400 })
  })

  it('retries 429 and 5xx with growing backoff, reusing the same idempotency key, then succeeds', async () => {
    const f = new FakeStripe()
    f.fail({ status: 429, json: { error: { type: 'invalid_request_error', code: 'rate_limit', message: 'Too many requests' } } }, { status: 503 })
    noSleep.waits = []
    const c = await stripeRequest<{ id: string }>('POST', '/v1/customers', { name: 'R' }, { fetchImpl: f.fetch, maxRetries: 2, sleep: noSleep.sleep })
    expect(c.id).toMatch(/^cus_/)
    expect(f.calls).toHaveLength(3)
    expect(new Set(f.calls.map(x => x.headers['idempotency-key'])).size).toBe(1)
    expect(noSleep.waits).toHaveLength(2)
    expect(noSleep.waits[1]).toBeGreaterThan(noSleep.waits[0])
    expect(retryDelayMs(1, 0)).toBe(375); expect(retryDelayMs(1, 1)).toBe(500); expect(retryDelayMs(10, 1)).toBe(5000)
  })

  it('gives up after the retry budget, and never retries what Stripe marks Stripe-Should-Retry: false', async () => {
    const f = new FakeStripe()
    f.fail({ status: 500 }, { status: 500 }, { status: 500 })
    await expect(stripeRequest('POST', '/v1/customers', {}, { fetchImpl: f.fetch, maxRetries: 2, sleep: noSleep.sleep })).rejects.toMatchObject({ kind: 'api_error', status: 500 })
    expect(f.calls).toHaveLength(3)
    const g = new FakeStripe()
    g.fail({ status: 500, headers: { 'stripe-should-retry': 'false' } })
    await expect(stripeRequest('POST', '/v1/customers', {}, { fetchImpl: g.fetch, maxRetries: 2, sleep: noSleep.sleep })).rejects.toBeInstanceOf(StripeError)
    expect(g.calls).toHaveLength(1)
    // a 400 is not retried
    const h = new FakeStripe()
    await expect(stripeRequest('GET', '/v1/subscriptions/sub_missing', {}, { fetchImpl: h.fetch, maxRetries: 2, sleep: noSleep.sleep })).rejects.toMatchObject({ kind: 'invalid_request', status: 404 })
    expect(h.calls).toHaveLength(1)
  })

  it('a network failure is retried and then reported as such', async () => {
    let n = 0
    const down = (async () => { n++; throw new TypeError('fetch failed') }) as unknown as typeof fetch
    await expect(stripeRequest('GET', '/v1/invoices', {}, { fetchImpl: down, maxRetries: 1, sleep: noSleep.sleep })).rejects.toMatchObject({ kind: 'network', status: 0 })
    expect(n).toBe(2)
  })

  it('maps Stripe errors to kinds and to honest messages for the owner', async () => {
    expect(stripeErrorKind(402, 'card_error')).toBe('card_error')
    expect(stripeErrorKind(429, 'invalid_request_error')).toBe('rate_limit')
    expect(stripeErrorKind(500, undefined)).toBe('api_error')
    expect(stripeErrorKind(401, 'invalid_request_error')).toBe('authentication')
    expect(stripeErrorKind(400, 'invalid_request_error')).toBe('invalid_request')
    const f = new FakeStripe()
    f.fail({ status: 402, json: { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } } })
    const e = await stripeRequest('POST', '/v1/customers', {}, { fetchImpl: f.fetch }).catch(x => x as StripeError)
    expect(e).toMatchObject({ kind: 'card_error', code: 'card_declined', declineCode: 'insufficient_funds' })
    expect(stripeFailureMessage(e as StripeError)).toEqual({ status: 402, code: 'card_declined', message: 'The card was declined (insufficient funds): update the payment method in the billing portal' })
    // through viaStripe an API caller gets an HttpError with that status and message
    await expect(viaStripe(() => Promise.reject(new StripeError(429, 'invalid_request_error', 'x', 'rate_limit')))).rejects.toMatchObject({ status: 503, code: 'stripe_busy' })
    await expect(viaStripe(() => Promise.reject(new StripeError(0, 'network', 'x', 'network')))).rejects.toMatchObject({ status: 502, code: 'stripe_unavailable' })
    // the wrong key never reaches anything but Stripe's own refusal
    await expect(stripeRequest('GET', '/v1/invoices', {}, { fetchImpl: new FakeStripe().fetch, key: ['sk', 'live', 'x'].join('_') })).rejects.toMatchObject({ kind: 'authentication' })
  })

  it('a local Stripe base URL is honoured only in test mode, outside production, on a loopback address', () => {
    expect(stripeApiBase({ BILLING_MODE: 'test', STRIPE_API_BASE: 'http://127.0.0.1:3517' })).toBe('http://127.0.0.1:3517')
    expect(stripeApiBase({ BILLING_MODE: 'live', STRIPE_API_BASE: 'http://127.0.0.1:3517' })).toBe('https://api.stripe.com')
    expect(stripeApiBase({ BILLING_MODE: 'test', STRIPE_API_BASE: 'http://127.0.0.1:3517', DEPLOI_ENV: 'production' })).toBe('https://api.stripe.com')
    expect(stripeApiBase({ BILLING_MODE: 'test', STRIPE_API_BASE: 'https://evil.example' })).toBe('https://api.stripe.com')
    expect(stripeApiBase({ BILLING_MODE: 'test', STRIPE_API_BASE: 'http://10.0.0.5:80' })).toBe('https://api.stripe.com')
    expect(stripeApiBase({ BILLING_MODE: 'test' })).toBe('https://api.stripe.com')
  })

  it('every request goes to api.stripe.com by default', async () => {
    const urls: string[] = []
    const rec = (async (u: string) => { urls.push(u); return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
    await stripeRequest('POST', '/v1/customers', {}, { fetchImpl: rec })
    expect(new URL(urls[0]).origin).toBe('https://api.stripe.com')
  })
})
