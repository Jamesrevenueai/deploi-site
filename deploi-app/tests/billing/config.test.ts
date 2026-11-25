/** BILLING_MODE defaults off; live is refused unless explicit, on production, with a live key; prices come only from env. */
import { describe, it, expect } from 'vitest'
import { billingMode, billingConfigProblems, assertBillingStartup, priceIdFor, planForPrice } from '../../lib/billing/config'
import { formEncode } from '../../lib/billing/stripe'
import { stateFromSubscription, type SubscriptionRow } from '../../lib/billing/state'
import { PLAN_LIMITS } from '../../lib/plans/entitlements'
import { tierByKey } from '../../lib/library/config'

// assembled at runtime so no key-shaped literal sits in the repository
const key = (kind: 'live' | 'test') => ['sk', kind, 'notreal'].join('_')
const WH = ['whsec', 'notreal'].join('_')

describe('billing configuration', () => {
  it('defaults to off, and off is the current free beta', () => {
    expect(billingMode({})).toBe('off')
    expect(billingMode({ BILLING_MODE: 'LIVE' })).toBe('live')
    expect(billingMode({ BILLING_MODE: 'on' })).toBe('off')
    expect(billingConfigProblems({})).toEqual([])
    expect(() => assertBillingStartup({})).not.toThrow()
  })
  it('test mode needs a test key and a webhook secret, and refuses a live key', () => {
    expect(billingConfigProblems({ BILLING_MODE: 'test', STRIPE_SECRET_KEY: key('test'), STRIPE_WEBHOOK_SECRET: WH })).toEqual([])
    expect(billingConfigProblems({ BILLING_MODE: 'test', STRIPE_SECRET_KEY: key('live'), STRIPE_WEBHOOK_SECRET: WH }).join()).toMatch(/refuses a key that is not a test key/)
    expect(billingConfigProblems({ BILLING_MODE: 'test' }).join()).toMatch(/needs STRIPE_SECRET_KEY/)
  })
  it('live mode refuses to start outside production or with a test key', () => {
    expect(() => assertBillingStartup({ BILLING_MODE: 'live', STRIPE_SECRET_KEY: key('live'), STRIPE_WEBHOOK_SECRET: WH })).toThrow(/only on the production deployment/)
    expect(() => assertBillingStartup({ BILLING_MODE: 'live', STRIPE_SECRET_KEY: key('test'), STRIPE_WEBHOOK_SECRET: WH, VERCEL_ENV: 'production' })).toThrow(/needs a live key/)
    expect(() => assertBillingStartup({ BILLING_MODE: 'live', STRIPE_SECRET_KEY: key('live'), STRIPE_WEBHOOK_SECRET: WH, VERCEL_ENV: 'production' })).not.toThrow()
  })
  it('a live key sitting in an environment with billing off is flagged; a typo in BILLING_MODE is flagged', () => {
    expect(() => assertBillingStartup({ STRIPE_SECRET_KEY: key('live') })).toThrow(/live Stripe key/)
    expect(billingConfigProblems({ BILLING_MODE: 'yes' }).join()).toMatch(/not one of off, test, live/)
  })
  it('prices are Stripe Price ids from STRIPE_PRICE_* only; nothing is hard-coded', () => {
    const env = { STRIPE_PRICE_STARTER_MONTHLY: 'price_A1', STRIPE_PRICE_GROWTH_MONTHLY: 'price_B2', STRIPE_PRICE_PRO_MONTHLY: '29' }
    expect(priceIdFor('starter', env)).toBe('price_A1')
    expect(priceIdFor('pro', env)).toBeNull()
    expect(priceIdFor('growth', {})).toBeNull()
    expect(planForPrice('price_B2', env)).toBe('growth')
    expect(planForPrice('price_other', env)).toBeNull()
  })
  it('form-encodes nested Stripe parameters', () => {
    expect(formEncode({ mode: 'subscription', line_items: [{ price: 'price_1', quantity: 1 }], metadata: { org_id: 'o' }, skip: undefined }))
      .toBe('mode=subscription&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Borg_id%5D=o')
  })
})

describe('plan limits and subscription state', () => {
  it('limits grow with the tier and the action allowance is the library tier allowance', () => {
    for (const k of ['starter', 'growth', 'pro'] as const) expect(PLAN_LIMITS[k].monthlyActions).toBe(tierByKey(k)!.monthlyActions)
    for (const f of ['maxAgents', 'maxCompetitorStores', 'monthlyActions', 'monthlyEmails', 'officeSeats', 'officeConnections'] as const) {
      expect(PLAN_LIMITS.starter[f]).toBeLessThan(PLAN_LIMITS.growth[f])
      expect(PLAN_LIMITS.growth[f]).toBeLessThan(PLAN_LIMITS.pro[f])
    }
  })
  const sub = (o: Partial<SubscriptionRow>): SubscriptionRow => ({ provider: 'stripe', status: 'active', plan: 'growth', external_id: 'sub_1', current_period_end: null, cancel_at_period_end: false, trial_end: null, past_due_since: null, livemode: false, ...o })
  const now = new Date('2026-11-10T00:00:00Z')
  it('off is never read-only; active and trialing are full service; no subscription is read-only', () => {
    expect(stateFromSubscription(null, { mode: 'off', graceDays: 7, now }).readOnly).toBe(false)
    expect(stateFromSubscription(sub({}), { mode: 'test', graceDays: 7, now }).readOnly).toBe(false)
    expect(stateFromSubscription(sub({ status: 'trialing' }), { mode: 'test', graceDays: 7, now }).readOnly).toBe(false)
    expect(stateFromSubscription(null, { mode: 'test', graceDays: 7, now })).toMatchObject({ status: 'none', readOnly: true })
  })
  it('past_due keeps full service for the grace period, then read-only; canceled, unpaid, incomplete are read-only', () => {
    const inGrace = stateFromSubscription(sub({ status: 'past_due', past_due_since: '2026-11-05T00:00:00Z' }), { mode: 'test', graceDays: 7, now })
    expect(inGrace).toMatchObject({ readOnly: false, graceEndsAt: '2026-11-12T00:00:00.000Z' })
    expect(inGrace.reason).toMatch(/payment failed/)
    expect(stateFromSubscription(sub({ status: 'past_due', past_due_since: '2026-11-01T00:00:00Z' }), { mode: 'test', graceDays: 7, now }).readOnly).toBe(true)
    for (const s of ['canceled', 'unpaid', 'incomplete', 'paused'] as const) expect(stateFromSubscription(sub({ status: s }), { mode: 'live', graceDays: 7, now }).readOnly, s).toBe(true)
  })
})
