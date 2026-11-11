/**
 * Stripe billing end to end against the test database, with a fake fetch (no request leaves the machine):
 * checkout (customer reuse, idempotency key, client_reference_id), Shopify routing, the signed webhook
 * route (signature, dedupe, livemode), subscription state, grace period and read-only enforcement.
 */
import '../merchant/env'
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { NW } from '../merchant/helpers'
import { createCheckoutSession, createPortalSession, checkoutIdempotencyKey } from '../../lib/billing/checkout'
import { signStripePayload } from '../../lib/billing/stripe'
import { billingProviderFor, billingWriteBlock } from '../../lib/billing/state'
import { orgEntitlements, billingSendBlock, entitlements } from '../../lib/plans/entitlements'
import { writeBlockReason } from '../../lib/engine/access'
import { POST as webhook } from '../../app/api/billing/stripe/webhook/route'
import { POST as planPost } from '../../app/api/store/plan/route'
import { signSessionToken } from '../../lib/connectors/shopify/auth'

const ready = await prepareDb()
const ORG = uuidFrom(`billing-flow-org:${process.pid}`)
const WH = ['whsec', 'flowtest', 'notreal'].join('_')
const ENV: Record<string, string> = {
  BILLING_MODE: 'test', STRIPE_SECRET_KEY: ['sk', 'test', 'notreal'].join('_'), STRIPE_WEBHOOK_SECRET: WH,
  STRIPE_PRICE_STARTER_MONTHLY: 'price_Starter1', STRIPE_PRICE_GROWTH_MONTHLY: 'price_Growth1', STRIPE_PRICE_PRO_MONTHLY: 'price_Pro1', BILLING_GRACE_DAYS: '7',
}

type Call = { url: string; method: string; headers: Record<string, string>; body: URLSearchParams }
function fakeStripe() {
  const calls: Call[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = new URLSearchParams(String(init?.body ?? ''))
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers, body })
    const path = new URL(String(url)).pathname
    const json = path === '/v1/customers' ? { id: 'cus_Flow1', livemode: false }
      : path === '/v1/checkout/sessions' ? { id: `cs_test_${calls.length}`, url: `https://checkout.stripe.com/c/pay/cs_test_${calls.length}` }
      : path === '/v1/billing_portal/sessions' ? { id: 'bps_1', url: 'https://billing.stripe.com/p/session/test_1' }
      : { error: { type: 'invalid_request_error', message: 'unknown' } }
    return new Response(JSON.stringify(json), { status: 'error' in json ? 404 : 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, impl }
}

let seq = 0
function event(type: string, object: Record<string, unknown>, opts: { created?: number; livemode?: boolean; id?: string } = {}) {
  seq++
  return { id: opts.id ?? `evt_flow_${process.pid}_${Date.now()}_${seq}`, type, created: opts.created ?? Math.floor(Date.now() / 1000) + seq, livemode: opts.livemode ?? false, data: { object } }
}
async function deliver(ev: unknown, opts: { secret?: string; header?: string } = {}) {
  const raw = JSON.stringify(ev)
  const res = await webhook(new Request('http://localhost/api/billing/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': opts.header ?? signStripePayload(raw, opts.secret ?? WH), 'content-type': 'application/json' }, body: raw }))
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}
const subRow = () => admin(db => db.one<{ status: string; plan: string; external_id: string; cancel_at_period_end: boolean; past_due_since: string | null; current_period_end: string | null }>(
  `select status, plan, external_id, cancel_at_period_end, past_due_since::text, current_period_end::text from billing_subscriptions where org_id = $1 and provider = 'stripe'`, [ORG]))
const subscription = (o: Record<string, unknown> = {}) => ({ id: 'sub_Flow1', object: 'subscription', customer: 'cus_Flow1', status: 'active', cancel_at_period_end: false, metadata: { org_id: ORG, plan: 'growth' },
  items: { data: [{ price: { id: 'price_Growth1' }, current_period_end: 1_900_000_000 }] }, ...o })

describe.skipIf(!ready)('Stripe billing flow', () => {
  const saved: Record<string, string | undefined> = {}
  beforeAll(async () => {
    await admin(async db => {
      await db.query('delete from agencies where id = $1', [ORG])
      await db.query(`insert into agencies (id, name, org_type, plan_tier) values ($1, 'Billing Flow Co', 'merchant', 'starter')`, [ORG])
    })
  })
  afterAll(async () => { await admin(db => db.query('delete from agencies where id = $1', [ORG])) })
  beforeEach(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v } })
  afterEach(() => { for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

  it('routes a Shopify-only organization to Shopify billing and refuses Stripe checkout for it', async () => {
    expect(await admin(db => billingProviderFor(db, NW.org))).toBe('shopify')
    expect(await admin(db => billingProviderFor(db, ORG))).toBe('stripe')
    const f = fakeStripe()
    await expect(admin(db => createCheckoutSession(db, { orgId: NW.org, plan: 'growth', actor: 'test', appUrl: 'https://app.example', fetchImpl: f.impl }))).rejects.toMatchObject({ code: 'use_shopify_billing', status: 409 })
    expect(f.calls).toHaveLength(0)
    // Shopify-billed organizations are never made read-only by Stripe state
    expect(await admin(db => billingWriteBlock(db, NW.org))).toBeNull()
  })

  it('creates a customer once, then a subscription Checkout Session with client_reference_id and an idempotency key', async () => {
    const f = fakeStripe()
    const now = new Date('2026-11-04T12:00:00Z')
    const r = await admin(db => createCheckoutSession(db, { orgId: ORG, plan: 'growth', email: 'owner@flow.example', actor: 'test', appUrl: 'https://app.example/', now, fetchImpl: f.impl }))
    expect(r.url).toMatch(/^https:\/\/checkout\.stripe\.com\//)
    expect(f.calls.map(c => new URL(c.url).pathname)).toEqual(['/v1/customers', '/v1/checkout/sessions'])
    for (const c of f.calls) { expect(new URL(c.url).host).toBe('api.stripe.com'); expect(c.headers.authorization).toBe(`Bearer ${ENV.STRIPE_SECRET_KEY}`); expect(c.headers['idempotency-key']).toBeTruthy() }
    expect(f.calls[0].body.get('metadata[org_id]')).toBe(ORG)
    const cs = f.calls[1].body
    expect(Object.fromEntries(cs)).toMatchObject({ mode: 'subscription', customer: 'cus_Flow1', client_reference_id: ORG, 'line_items[0][price]': 'price_Growth1', 'line_items[0][quantity]': '1', 'subscription_data[metadata][org_id]': ORG, 'metadata[plan]': 'growth' })
    expect(cs.get('success_url')).toBe('https://app.example/store/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}')
    expect(f.calls[1].headers['idempotency-key']).toBe(checkoutIdempotencyKey(ORG, 'growth', 'price_Growth1', now))
    // a second checkout reuses the customer
    const g = fakeStripe()
    await admin(db => createCheckoutSession(db, { orgId: ORG, plan: 'pro', actor: 'test', appUrl: 'https://app.example', fetchImpl: g.impl }))
    expect(g.calls.map(c => new URL(c.url).pathname)).toEqual(['/v1/checkout/sessions'])
    await expect(admin(db => createCheckoutSession(db, { orgId: ORG, plan: 'enterprise', actor: 'test', appUrl: 'https://app.example', fetchImpl: g.impl }))).rejects.toMatchObject({ code: 'invalid_input' })
    delete process.env.STRIPE_PRICE_PRO_MONTHLY
    await expect(admin(db => createCheckoutSession(db, { orgId: ORG, plan: 'pro', actor: 'test', appUrl: 'https://app.example', fetchImpl: g.impl }))).rejects.toMatchObject({ code: 'billing_not_configured' })
  })

  it('the webhook refuses bad signatures, is off while BILLING_MODE is off, and ignores the wrong livemode', async () => {
    const ev = event('invoice.paid', { customer: 'cus_Flow1' })
    expect((await deliver(ev, { secret: 'whsec_wrong' })).status).toBe(400)
    expect((await deliver(ev, { header: 't=1,v1=' + '0'.repeat(64) })).status).toBe(400)
    process.env.BILLING_MODE = 'off'
    expect((await deliver(ev)).status).toBe(503)
    process.env.BILLING_MODE = 'test'
    expect((await deliver(event('customer.subscription.updated', subscription({ status: 'canceled' }), { livemode: true }))).json).toMatchObject({ ignored: expect.any(String) })
    expect(await subRow()).toBeNull()
  })

  it('checkout, subscription and invoice events drive the subscription; duplicates and older events are ignored', async () => {
    expect((await deliver(event('checkout.session.completed', { mode: 'subscription', client_reference_id: ORG, customer: 'cus_Flow1', subscription: 'sub_Flow1', metadata: { plan: 'growth' } }))).json).toMatchObject({ ok: true, outcome: 'processed' })
    expect(await subRow()).toMatchObject({ status: 'incomplete', external_id: 'sub_Flow1' })
    expect(await admin(db => billingWriteBlock(db, ORG))).toMatch(/read-only/)

    const created = event('customer.subscription.created', subscription(), { created: Math.floor(Date.now() / 1000) - 60 })
    expect((await deliver(created)).json).toMatchObject({ outcome: 'processed' })
    expect(await subRow()).toMatchObject({ status: 'active', plan: 'growth' })
    expect((await deliver(created)).json).toMatchObject({ duplicate: true })
    expect((await admin(db => db.one<{ plan_tier: string }>('select plan_tier from agencies where id = $1', [ORG])))!.plan_tier).toBe('growth')
    const e = await admin(db => orgEntitlements(db, ORG))
    expect(e).toMatchObject({ tier: 'growth', priced: true, writesAllowed: true, maxAgents: 12, monthlyActions: 500 })
    expect(await admin(db => billingWriteBlock(db, ORG))).toBeNull()

    // an event older than the last applied one changes nothing
    expect((await deliver(event('customer.subscription.updated', subscription({ status: 'canceled' }), { created: Math.floor(Date.now() / 1000) - 3600 }))).json).toMatchObject({ outcome: 'ignored' })
    expect((await subRow())!.status).toBe('active')

    // payment fails: past due, full service during the grace period, then read-only
    await deliver(event('invoice.payment_failed', { customer: 'cus_Flow1', subscription: 'sub_Flow1', attempt_count: 1 }))
    const pd = await subRow()
    expect(pd).toMatchObject({ status: 'past_due' })
    expect(pd!.past_due_since).toBeTruthy()
    expect((await admin(db => orgEntitlements(db, ORG))).writesAllowed).toBe(true)
    const later = new Date(new Date(pd!.past_due_since!).getTime() + 8 * 86400e3)
    const ro = await admin(db => orgEntitlements(db, ORG, later))
    expect(ro.writesAllowed).toBe(false)
    expect(await admin(db => billingSendBlock(db, ORG, later))).toMatch(/read-only/)

    // paid again: recovered
    await deliver(event('invoice.paid', { customer: 'cus_Flow1', parent: { subscription_details: { subscription: 'sub_Flow1' } } }))
    expect(await subRow()).toMatchObject({ status: 'active', past_due_since: null })

    // cancelled at period end, then deleted: read-only, data stays
    await deliver(event('customer.subscription.updated', subscription({ cancel_at_period_end: true })))
    expect((await subRow())!.cancel_at_period_end).toBe(true)
    expect(await admin(db => billingWriteBlock(db, ORG))).toBeNull()
    await deliver(event('customer.subscription.deleted', subscription({ status: 'canceled' })))
    expect((await subRow())!.status).toBe('canceled')
    expect(await admin(db => billingWriteBlock(db, ORG))).toMatch(/cancelled/)
    // the engine's write gate refuses a real store write for a read-only organization
    expect(await admin(db => writeBlockReason(db, { id: uuidFrom('fake-conn'), org_id: ORG, platform: 'woocommerce', external_id: 'https://flow.example', is_synthetic: false }))).toMatch(/read-only/)

    // the portal opens for the known customer
    const f = fakeStripe()
    expect((await admin(db => createPortalSession(db, { orgId: ORG, actor: 'test', appUrl: 'https://app.example', fetchImpl: f.impl }))).url).toMatch(/^https:\/\/billing\.stripe\.com\//)
    expect(f.calls[0].body.get('customer')).toBe('cus_Flow1')
  })

  it('a subscription event cannot be attached to another organization by metadata', async () => {
    const before = await subRow()
    const ev = event('customer.subscription.updated', subscription({ customer: 'cus_Flow1', metadata: { org_id: NW.org } }))
    expect((await deliver(ev)).json).toMatchObject({ outcome: 'ignored' })
    expect(await admin(db => db.one(`select id from billing_subscriptions where org_id = $1`, [NW.org]))).toBeNull()
    expect(await subRow()).toEqual(before)
  })

  it('with billing on, the free plan switch is refused: the tier follows the paid subscription', async () => {
    // inside Shopify the library tier switch does not exist at all (lib/shopify/embedded.ts): Shopify merchants change plans on Shopify's plan page
    const auth = `Bearer ${signSessionToken({ dest: `https://${NW.domain}`, sub: '7' }, process.env.SHOPIFY_API_SECRET!, process.env.SHOPIFY_API_KEY!)}`
    const res = await planPost(new Request('http://localhost/api/store/plan', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ tier: 'pro' }) }))
    expect(res.status).toBe(404)
    // for the web app the switch is refused while billing is on (SECURITY-REVIEW F-09)
    expect(readFileSync('app/api/store/plan/route.ts', 'utf8')).toMatch(/billingMode\(\) !== 'off'\) throw new HttpError\(409, 'use_billing'/)
  })

  it('with BILLING_MODE off the free beta is unchanged: no read-only, env limits', async () => {
    process.env.BILLING_MODE = 'off'
    expect(await admin(db => billingWriteBlock(db, ORG))).toBeNull()
    expect(await admin(db => billingSendBlock(db, ORG))).toBeNull()
    const e = await admin(db => orgEntitlements(db, ORG))
    expect(e).toMatchObject({ priced: false, writesAllowed: true, maxAgents: entitlements().maxAgents, label: 'Free beta' })
    await expect(admin(db => createCheckoutSession(db, { orgId: ORG, plan: 'growth', actor: 'test', appUrl: 'https://app.example' }))).rejects.toMatchObject({ code: 'billing_off' })
  })
})
