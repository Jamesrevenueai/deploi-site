/**
 * Billing v2 against the test database (lib/billing/v2.ts). No request leaves the machine:
 *   Store   the Shopify Billing API on a synthetic Shopify store: appSubscriptionCreate with the catalog price and a
 *           usage line item capped at the merchant's cap (test: true outside live), yearly at 10 months without a usage
 *           line, and overage as appUsageRecordCreate in whole $5 blocks, charged once, never above the cap.
 *   Office  Stripe Checkout bodies for Solo, Team and Business (monthly, yearly, setup, 20% with a Store plan) and
 *           overage as invoice items, through a fake Stripe.
 */
import '../merchant/env'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import { CATALOG, priceCents, storePlan, officePlan } from '../../lib/pricing'
import { setSyntheticState, getSyntheticState, mutateSynthetic, commerceQuietState } from '../../lib/connectors/shopify/synthetic'
import { shopifySubscriptionVariables, startShopifySubscription, chargeOverage, pendingOverage, officeQuote, createOfficeCheckout } from '../../lib/billing/v2'
import { recordAction, usageState, capCheck } from '../../lib/metering'
import { parseForm } from './fake-stripe'

const ready = await prepareDb()
const ORG = uuidFrom(`billing-v2-org:${process.pid}`)
const CONN = uuidFrom(`billing-v2-conn:${process.pid}`)
const ENV = { BILLING_MODE: 'test', STRIPE_SECRET_KEY: ['sk', 'test', 'v2notreal'].join('_'), STRIPE_WEBHOOK_SECRET: ['whsec', 'v2', 'notreal'].join('_'), STRIPE_MAX_RETRIES: '0' }
const saved: Record<string, string | undefined> = {}

async function makeOrg() {
  await admin(async db => {
    await db.query('delete from agencies where id = $1', [ORG])
    await db.query(`insert into agencies (id, name, org_type, plan_tier, plan_key) values ($1, 'Billing v2 Co', 'merchant', 'starter', 'starter')`, [ORG])
    await db.query(`insert into store_connections (id, org_id, platform, external_id, display_name, status, is_synthetic, currency) values ($1,$2,'shopify',$3,'v2 store','active',true,'USD')`, [CONN, ORG, `billing-v2-${process.pid}.myshopify.com`])
  })
  await setSyntheticState(CONN, commerceQuietState())
}
const actions = (n: number, kind: 'action' | 'text' = 'action', tag = 'x') => admin(async db => {
  for (let i = 0; i < n; i++) await recordAction(db, { orgId: ORG, agentKey: 'order_tracker', type: kind === 'text' ? 'send_text' : 'update_order', kind, proofRef: `DC-${i}`, dedupeKey: `${tag}:${kind}:${i}` })
})
const activate = () => mutateSynthetic(CONN, s => { for (const x of s.subscriptions) x.status = 'ACTIVE' }).then(() => admin(db => db.query(`update app_subscriptions set status = 'active' where org_id = $1`, [ORG])))

beforeAll(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v } })
afterAll(async () => {
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  if (ready) await admin(db => db.query('delete from agencies where id = $1', [ORG]))
})

describe('Store subscription input (Shopify Billing API) from the catalog', () => {
  for (const plan of ['starter', 'growth', 'pro'] as const) {
    it(`${plan}: monthly recurring price + usage line capped at the merchant cap; yearly = 10 months, no usage line`, () => {
      const m = shopifySubscriptionVariables(plan, 'month', { capCents: 5000, test: true, returnUrl: 'https://app.example/back' })
      expect(m).toMatchObject({ name: `Deploi ${storePlan(plan).name}`, test: true, trialDays: 14 })
      expect(m.lineItems).toEqual([
        { plan: { appRecurringPricingDetails: { price: { amount: storePlan(plan).monthlyCents / 100, currencyCode: 'USD' }, interval: 'EVERY_30_DAYS' } } },
        { plan: { appUsagePricingDetails: { cappedAmount: { amount: 50, currencyCode: 'USD' }, terms: `$5 per 100 actions over the ${storePlan(plan).actions.toLocaleString('en-US')} included each month, up to your cap` } } },
      ])
      const y = shopifySubscriptionVariables(plan, 'year', { capCents: 0, test: true, returnUrl: 'https://app.example/back' })
      expect(y.lineItems).toEqual([{ plan: { appRecurringPricingDetails: { price: { amount: (storePlan(plan).monthlyCents * 10) / 100, currencyCode: 'USD' }, interval: 'ANNUAL' } } }])
      expect(priceCents(plan, 'year')).toBe(storePlan(plan).monthlyCents * 10)
    })
  }
  it('prices are $79 / $199 / $499 with 1,500 / 5,000 / 15,000 actions', () => {
    expect(CATALOG.store.plans.map(p => [p.key, p.monthlyCents, p.actions])).toEqual([['starter', 7900, 1500], ['growth', 19900, 5000], ['pro', 49900, 15000]])
  })
  it('refuses a monthly plan without a usable cap', () => {
    expect(() => shopifySubscriptionVariables('starter', 'month', { capCents: 100, test: true, returnUrl: 'https://a.example' })).toThrow(/at least \$5/)
  })
})

describe.skipIf(!ready)('Store billing on a synthetic Shopify store (test mode)', () => {
  beforeEach(makeOrg)

  it('creates a TEST subscription with a usage line item, records it, and sets the cap', async () => {
    const r = await admin(db => startShopifySubscription(db, { orgId: ORG, connectionId: CONN, plan: 'growth', interval: 'month', capCents: 2000, returnUrl: 'https://app.example/store/billing', actor: 'test' }))
    expect(r).toMatchObject({ status: 'PENDING', test: true, interval: 'month' })
    expect(r.confirmationUrl).toMatch(/^https:\/\/.+\/admin\/charges\/synthetic\/\d+\/confirm$/)
    expect(r.usageLineItemId).toMatch(/^gid:\/\/shopify\/AppSubscriptionLineItem\//)
    const sub = (await getSyntheticState(CONN))!.subscriptions.at(-1)!
    expect(sub).toMatchObject({ test: true, trialDays: 14, name: 'Deploi Growth' })
    expect(sub.lineItems).toEqual([expect.objectContaining({ kind: 'recurring', priceCents: 19900, interval: 'EVERY_30_DAYS' }), expect.objectContaining({ kind: 'usage', cappedCents: 2000 })])
    const row = await admin(db => db.one<{ plan_key: string; status: string; is_test: boolean; usage_line_item_id: string; billing_interval: string }>(`select plan_key, status, is_test, usage_line_item_id, billing_interval from app_subscriptions where org_id = $1`, [ORG]))
    expect(row).toEqual({ plan_key: 'growth', status: 'pending', is_test: true, usage_line_item_id: r.usageLineItemId, billing_interval: 'month' })
    expect((await admin(db => usageState(db, ORG))).actions).toMatchObject({ overageAllowed: 400 }) // $20 cap = 4 blocks of 100
  })

  it('overage: whole $5 blocks as usage records, charged once, never above the capped amount; non-urgent work pauses at the cap', async () => {
    await admin(db => startShopifySubscription(db, { orgId: ORG, connectionId: CONN, plan: 'starter', interval: 'month', capCents: 1000, returnUrl: 'https://app.example/b', actor: 'test' }))
    await activate()
    await actions(1500 + 101) // 101 over: 2 blocks
    expect(await admin(db => pendingOverage(db, ORG))).toEqual([expect.objectContaining({ kind: 'action', blocksTotal: 2, newBlocks: 2, amountCents: 1000 })])
    const first = await admin(db => chargeOverage(db, ORG, { actor: 'test' }))
    expect(first.charged.map(c => [c.newBlocks, c.amountCents])).toEqual([[2, 1000]])
    let recs = (await getSyntheticState(CONN))!.usageRecords!
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ amountCents: 1000, description: expect.stringMatching(/200 actions over the plan \(2 x \$5 per 100\)/) })
    // again: nothing new to charge
    expect((await admin(db => chargeOverage(db, ORG))).charged).toEqual([])
    // more work beyond the $10 cap (2 blocks) is never charged, and non-urgent work is held
    await actions(200, 'action', 'more')
    expect(await admin(db => pendingOverage(db, ORG))).toEqual([])
    expect((await admin(db => chargeOverage(db, ORG))).charged).toEqual([])
    recs = (await getSyntheticState(CONN))!.usageRecords!
    expect(recs.reduce((a, r) => a + r.amountCents, 0)).toBe(1000)
    expect(await admin(db => capCheck(db, ORG, 'update_order'))).toMatchObject({ allowed: false })
    expect(await admin(db => capCheck(db, ORG, 'send_customer_reply'))).toEqual({ allowed: true }) // urgent
    expect(await admin(db => capCheck(db, ORG, 'scan_orders'))).toEqual({ allowed: true }) // watching is free
    const charges = await admin(db => db.query<{ blocks_total: number; amount_cents: number; provider: string }>('select blocks_total, amount_cents, provider from usage_charges where org_id = $1', [ORG]))
    expect(charges).toEqual([{ blocks_total: 2, amount_cents: 1000, provider: 'shopify' }])
  })

  it('yearly: ANNUAL at 10 months and no usage line (Shopify allows none), so overage is never charged', async () => {
    const r = await admin(db => startShopifySubscription(db, { orgId: ORG, connectionId: CONN, plan: 'pro', interval: 'year', returnUrl: 'https://app.example/b', actor: 'test' }))
    expect(r.usageLineItemId).toBeNull()
    expect((await getSyntheticState(CONN))!.subscriptions.at(-1)!.lineItems).toEqual([expect.objectContaining({ kind: 'recurring', priceCents: 499000, interval: 'ANNUAL' })])
    await activate()
    await admin(db => db.query(`update agencies set plan_key = 'starter', plan_tier = 'starter' where id = $1`, [ORG]))
    await admin(db => db.query('update org_usage_caps set action_overage_cap_cents = 500 where org_id = $1', [ORG]))
    await actions(1501, 'action', 'y')
    expect((await admin(db => chargeOverage(db, ORG))).charged).toEqual([])
  })
})

describe.skipIf(!ready)('Office checkout (Stripe test mode, inline catalog prices)', () => {
  type Call = { path: string; params: Record<string, unknown>; key: string | undefined }
  let calls: Call[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    calls.push({ path, params: parseForm(new URLSearchParams(String(init?.body ?? ''))) as Record<string, unknown>, key: headers['idempotency-key'] })
    const json = path === '/v1/customers' ? { id: 'cus_V2Office', livemode: false }
      : path === '/v1/checkout/sessions' ? { id: `cs_test_v2_${calls.length}`, url: `https://checkout.stripe.com/c/pay/cs_test_v2_${calls.length}` }
      : path === '/v1/invoiceitems' ? { id: `ii_v2_${calls.length}` } : { error: { type: 'invalid_request_error', message: 'unknown' } }
    return new Response(JSON.stringify(json), { status: 'error' in json ? 404 : 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  beforeEach(async () => { calls = []; await makeOrg(); await admin(db => db.query(`delete from store_connections where id = $1`, [CONN])) })
  afterEach(() => { calls = [] })

  for (const plan of ['solo', 'team', 'business'] as const) {
    it(`${plan}: monthly checkout at the catalog price with the 14-day trial; yearly at 10 months`, async () => {
      const r = await admin(db => createOfficeCheckout(db, { orgId: ORG, plan, interval: 'month', email: 'owner@v2.example', appUrl: 'https://app.example', actor: 'test', fetchImpl }))
      expect(r.url).toMatch(/^https:\/\/checkout\.stripe\.com\//)
      const s = calls.find(c => c.path === '/v1/checkout/sessions')!.params as { mode: string; line_items: Record<string, { price_data: { unit_amount: string; recurring?: { interval: string } } }>; subscription_data: { trial_period_days: string; metadata: { plan_key: string } } }
      expect(s.mode).toBe('subscription')
      expect(s.line_items['0'].price_data).toMatchObject({ unit_amount: String(officePlan(plan).monthlyCents), recurring: { interval: 'month' } })
      expect(s.line_items['1']).toBeUndefined()
      expect(s.subscription_data).toMatchObject({ trial_period_days: '14', metadata: { plan_key: plan } })
      calls = []
      await admin(db => createOfficeCheckout(db, { orgId: ORG, plan, interval: 'year', appUrl: 'https://app.example', actor: 'test', fetchImpl }))
      const y = calls.find(c => c.path === '/v1/checkout/sessions')!.params as typeof s
      expect(y.line_items['0'].price_data).toMatchObject({ unit_amount: String(officePlan(plan).monthlyCents * 10), recurring: { interval: 'year' } })
    })
  }
  it('prices are $149 / $349 / $799 with 2,000 / 6,000 / 20,000 actions and 300 / 1,000 / 4,000 texts', () => {
    expect(CATALOG.office.plans.map(p => [p.key, p.monthlyCents, p.actions, p.texts])).toEqual([['solo', 14900, 2000, 300], ['team', 34900, 6000, 1000], ['business', 79900, 20000, 4000]])
  })
  it('setup $499 on Solo and Team (included in Business); 20% off with a Store plan', () => {
    expect(officeQuote('solo', 'month', { hasStore: false, setup: true })).toMatchObject({ recurringCents: 14900, setupCents: 49900 })
    expect(officeQuote('team', 'month', { hasStore: true, setup: true })).toMatchObject({ recurringCents: 27920, setupCents: 49900, bundle: true })
    expect(officeQuote('business', 'month', { hasStore: false, setup: true })).toMatchObject({ setupCents: 0 })
    expect(officeQuote('business', 'year', { hasStore: true, setup: false })).toMatchObject({ recurringCents: Math.round(79900 * 10 * 0.8) })
  })
  it('the setup line is a one-time item in the same checkout', async () => {
    await admin(db => createOfficeCheckout(db, { orgId: ORG, plan: 'team', interval: 'month', setup: true, appUrl: 'https://app.example', actor: 'test', fetchImpl }))
    const s = calls.find(c => c.path === '/v1/checkout/sessions')!.params as { line_items: Record<string, { price_data: { unit_amount: string; recurring?: unknown } }> }
    expect(s.line_items['1'].price_data).toMatchObject({ unit_amount: '49900' })
    expect(s.line_items['1'].price_data.recurring).toBeUndefined()
  })
  it('overage: $5 per 100 actions and $3 per 100 texts as invoice items, within the cap, once', async () => {
    await admin(async db => {
      await db.query(`update agencies set plan_key = 'solo', plan_tier = 'starter' where id = $1`, [ORG])
      await db.query(`insert into billing_customers (org_id, external_id, livemode) values ($1, 'cus_V2Office', false) on conflict (org_id) do nothing`, [ORG])
      await db.query(`insert into org_usage_caps (org_id, action_overage_cap_cents, text_overage_cap_cents, updated_by) values ($1, 2500, 300, 'test') on conflict (org_id) do update set action_overage_cap_cents = 2500, text_overage_cap_cents = 300`, [ORG])
    })
    await actions(2000 + 250, 'action', 'o')
    await actions(300 + 150, 'text', 'o')
    const r = await admin(db => chargeOverage(db, ORG, { fetchImpl }))
    expect(r.charged.map(c => [c.kind, c.newBlocks, c.amountCents])).toEqual([['action', 3, 1500], ['text', 1, 300]]) // texts capped at $3 = 1 block
    const items = calls.filter(c => c.path === '/v1/invoiceitems').map(c => [c.params.amount, c.params.currency])
    expect(items).toEqual([['1500', 'usd'], ['300', 'usd']])
    calls = []
    expect((await admin(db => chargeOverage(db, ORG, { fetchImpl }))).charged).toEqual([])
    expect(calls).toEqual([])
  })
})
