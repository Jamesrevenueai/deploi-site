/**
 * Internal financial reporting: MRR/ARR (live, test and hypothesis-priced), trials and conversion, churn,
 * failed payments, the CSV export (formula-safe), and the in-app billing banner rules.
 */
import { describe, it, expect } from 'vitest'
import { computeFinance, csvCell, financeCsv, type FinSub, type FinanceReport } from '../../lib/billing/finance'
import { billingBanner, type BannerInput } from '../../lib/billing/messages'

const plans = [
  { key: 'starter', name: 'Starter', priceCents: 2900, currency: 'usd', status: 'hypothesis' },
  { key: 'growth', name: 'Growth', priceCents: 7900, currency: 'usd', status: 'approved' },
  { key: 'pro', name: 'Pro', priceCents: 19900, currency: 'usd', status: 'hypothesis' },
]
const sub = (o: Partial<FinSub>): FinSub => ({ orgId: 'o', orgName: 'O', provider: 'stripe', status: 'active', planKey: 'growth', livemode: true, createdAt: '2026-09-01T00:00:00.000Z', endedAt: null, cancelAtPeriodEnd: false, cancelReason: null, ...o })

describe('finance math', () => {
  const subs: FinSub[] = [
    sub({ orgId: 'a', planKey: 'growth' }),                                   // live, approved: 79
    sub({ orgId: 'b', planKey: 'pro', status: 'past_due' }),                   // in grace: still MRR, hypothesis price: 199
    sub({ orgId: 'c', planKey: 'starter', livemode: false }),                  // test mode: 29 test MRR
    sub({ orgId: 'd', planKey: 'pro', status: 'trialing', createdAt: '2026-11-03T00:00:00.000Z' }), // a trial is not revenue
    sub({ orgId: 'e', planKey: 'growth', status: 'canceled', endedAt: '2026-11-10T00:00:00.000Z', cancelReason: 'too_expensive' }), // churned in Nov
    sub({ orgId: 'f', planKey: 'starter', status: 'canceled', endedAt: '2026-10-20T00:00:00.000Z' }), // churned before Nov: not at start
    sub({ orgId: 'g', planKey: 'nope' }),                                      // unpriced
    sub({ orgId: 'h', provider: 'shopify', planKey: 'starter' }),               // Shopify App Pricing, live
    sub({ orgId: 'i', planKey: 'growth', cancelAtPeriodEnd: true }),            // set to end
    sub({ orgId: 'j', status: 'incomplete', planKey: 'pro' }),                  // never started
  ]
  const trials = [
    { orgId: 'd', startedAt: '2026-11-03T00:00:00.000Z', endsAt: '2026-11-17T00:00:00.000Z', endedAt: null, outcome: 'trialing', convertedAt: null },
    { orgId: 'a', startedAt: '2026-10-20T00:00:00.000Z', endsAt: '2026-11-03T00:00:00.000Z', endedAt: '2026-11-03T00:00:00.000Z', outcome: 'converted', convertedAt: '2026-11-03T00:00:00.000Z' },
    { orgId: 'k', startedAt: '2026-10-25T00:00:00.000Z', endsAt: '2026-11-08T00:00:00.000Z', endedAt: '2026-11-08T00:00:00.000Z', outcome: 'lapsed', convertedAt: null },
    { orgId: 'l', startedAt: '2026-11-02T00:00:00.000Z', endsAt: '2026-11-16T00:00:00.000Z', endedAt: '2026-11-05T00:00:00.000Z', outcome: 'canceled', convertedAt: null },
    { orgId: 'm', startedAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-09-15T00:00:00.000Z', endedAt: '2026-09-15T00:00:00.000Z', outcome: 'converted', convertedAt: '2026-09-15T00:00:00.000Z' },
  ]
  const failures = [
    { orgId: 'b', failedAt: '2026-11-02T00:00:00.000Z', amountDueCents: 19900, recoveredAt: null },
    { orgId: 'b', failedAt: '2026-11-05T00:00:00.000Z', amountDueCents: 19900, recoveredAt: null },
    { orgId: 'a', failedAt: '2026-11-01T10:00:00.000Z', amountDueCents: 7900, recoveredAt: '2026-11-02T00:00:00.000Z' },
    { orgId: 'z', failedAt: '2026-10-30T00:00:00.000Z', amountDueCents: 2900, recoveredAt: '2026-10-31T00:00:00.000Z' },
  ]
  const f = computeFinance({ month: '2026-11', plans, subs, trials, failures })

  it('MRR counts active and past-due subscriptions at plan prices; trials, test mode, ended and unpriced are separated', () => {
    // live: a 79 + b 199 + h 29 (Shopify) + i 79 = 386
    expect(f.mrr.liveCents).toBe(7900 + 19900 + 2900 + 7900)
    expect(f.mrr.testCents).toBe(2900)
    expect(f.mrr.arrLiveCents).toBe(f.mrr.liveCents * 12)
    // hypothesis-priced live MRR: pro (b) and starter (h)
    expect(f.mrr.hypothesisCents).toBe(19900 + 2900)
    expect(f.mrr.pricesAreHypotheses).toBe(true)
    expect(f.mrr.unpriced).toBe(1)
    expect(f.mrr.subscriptions).toBe(6) // a, b, c, g, h, i
    expect(f.mrr.byPlan.map(p => [p.planKey, p.count, p.mrrCents, p.hypothesis])).toEqual([['pro', 1, 19900, true], ['growth', 2, 15800, false], ['starter', 2, 5800, true]])
  })

  it('trials: started in the month, conversion among those that ended in it, running now', () => {
    expect(f.trials).toEqual({ started: 2, ended: 3, converted: 1, lapsed: 1, canceled: 1, conversionPct: 33.3, running: 1 })
  })

  it('churn: ended in the month against those active at its start, with the MRR lost and the reasons', () => {
    // at start of Nov: a, b, c, e, g, h, i (created before, not ended); f ended in Oct; d created in Nov; j incomplete
    expect(f.churn).toMatchObject({ churned: 1, activeAtStart: 7, churnPct: 14.3, churnedMrrCents: 7900, reasons: { too_expensive: 1 }, scheduled: 1 })
  })

  it('failed payments: attempts in the month, organizations affected, amount due, recovered, open now', () => {
    expect(f.failedPayments).toEqual({ attempts: 3, orgs: 2, amountDueCents: 19900 * 2 + 7900, recovered: 1, openNow: 1 })
  })

  it('all-approved live prices are not flagged; an empty month divides by nothing', () => {
    const g = computeFinance({ month: '2026-11', plans, subs: [sub({ planKey: 'growth' })], trials: [], failures: [] })
    expect(g.mrr.pricesAreHypotheses).toBe(false)
    expect(g.trials.conversionPct).toBeNull()
    expect(g.churn.churnPct).toBe(0)
    expect(computeFinance({ month: '2026-11', plans, subs: [], trials: [], failures: [] }).churn.churnPct).toBeNull()
  })

  it('the CSV export quotes what needs quoting and neutralizes formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+1')).toBe(`'+1`)
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell(null)).toBe('')
    const r = { summary: f, totals: { revenueUsd: 0, variableCostUsd: 0, verifiedResolutions: 0, flagged: 0 }, prices: {} as FinanceReport['prices'],
      orgs: [{ orgId: 'o1', orgName: '@Evil, Inc', plan: 'pro', subscriptionStatus: 'active', revenueCents: 19900, aiCostUsd: 1.5, aiCalls: 3, jobRuns: 1, providerCalls: {}, emailsSent: 2, verifiedResolutions: 4,
        revenueUsd: 199, providerCostUsd: 0.1, jobCostUsd: 0.0002, emailCostUsd: 0.0018, variableCostUsd: 1.602, costPerResolutionUsd: 0.4005, grossMarginPct: 99.2, target: { minUsd: 1, maxUsd: 2 }, flags: [],
        provider: 'stripe', planName: 'Pro', planPriceCents: 19900, hypothesisPrice: true, livemode: true, mrrCents: 19900, failedPayments: 2, trialOutcome: 'converted' }] } as unknown as FinanceReport
    const csv = financeCsv(r)
    const [head, row] = csv.trim().split('\r\n')
    expect(head.split(',')).toContain('price_is_hypothesis')
    expect(row).toContain(`"'@Evil, Inc"`)
    expect(row).toMatch(/^2026-11,o1,"'@Evil, Inc",stripe,Pro,199,true,true,active,199,199,/)
  })
})

describe('billing banner', () => {
  const base: BannerInput = { mode: 'test', provider: 'stripe', status: 'active', readOnly: false, reason: null, graceEndsAt: null, trialEnd: null, cancelAtPeriodEnd: false, currentPeriodEnd: '2026-12-01T00:00:00.000Z', openFailures: 0 }
  const now = new Date('2026-11-05T12:00:00Z')
  it('says nothing when all is well, while billing is off, or for Shopify-billed stores', () => {
    expect(billingBanner(base, now)).toBeNull()
    expect(billingBanner({ ...base, mode: 'off', status: 'past_due' }, now)).toBeNull()
    expect(billingBanner({ ...base, provider: 'shopify', status: 'past_due' }, now)).toBeNull()
  })
  it('payment failed in grace, read-only after it, ended, trial ending, cancellation scheduled', () => {
    expect(billingBanner({ ...base, status: 'past_due', graceEndsAt: '2026-11-12T00:00:00.000Z' }, now)).toEqual({ tone: 'warn', message: 'Payment failed. Update your payment method before 2026-11-12 to keep your agents running.', cta: 'Update payment method' })
    expect(billingBanner({ ...base, status: 'past_due', readOnly: true }, now)!.tone).toBe('danger')
    expect(billingBanner({ ...base, status: 'canceled', readOnly: true }, now)).toMatchObject({ tone: 'danger', cta: 'Choose a plan' })
    expect(billingBanner({ ...base, status: 'trialing', trialEnd: '2026-11-07T12:00:00Z' }, now)).toMatchObject({ tone: 'info', message: expect.stringMatching(/^Your trial ends in 2 days \(2026-11-07\)/) })
    expect(billingBanner({ ...base, status: 'trialing', trialEnd: '2026-11-15T12:00:00Z' }, now)).toBeNull()
    expect(billingBanner({ ...base, cancelAtPeriodEnd: true }, now)).toMatchObject({ cta: 'Reactivate', message: 'Your subscription ends on 2026-12-01; after that the account is read-only.' })
  })
})
