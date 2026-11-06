/**
 * Internal financial reporting (staff only): MRR and ARR, trials and conversion, churn, failed payments, and
 * revenue against variable cost per organization (lib/platform/economics.ts).
 *
 *   MRR        a snapshot as of now: every subscription in good standing or in its grace period (Stripe
 *              active or past_due; Shopify App Pricing active) x the monthly price of its plan in the plans
 *              table. Trials are not revenue. A subscription whose plan has no row is counted as unpriced.
 *              Live and test-mode subscriptions are reported separately; MRR from plans whose price is still a
 *              hypothesis is flagged (it is a proposal, not an approved price).
 *   ARR        MRR x 12.
 *   trials     started in the month; ended in the month (converted, lapsed, cancelled); conversion =
 *              converted / ended among trials that ended in the month; running now.
 *   churn      subscriptions that ended in the month, against those that had started before the month and
 *              had not ended by its start (logo churn); the MRR they carried; the reasons given.
 *   failed     payment failures recorded in the month (each Stripe attempt), the organizations affected, the
 *              amount due, how many have since been recovered; and the failures open now.
 * Everything is computed from our records of what Stripe and Shopify confirmed; amounts are the plans
 * table's prices, not Stripe's invoices (the invoices are in Stripe).
 */
import type { Db } from '../db'
import { economicsReport, monthRange, type OrgEconomics } from '../platform/economics'

export type FinPlan = { key: string; name: string; priceCents: number; currency: string; status: string }
export type FinSub = { orgId: string; orgName: string; provider: 'stripe' | 'shopify'; status: string; planKey: string | null; livemode: boolean; createdAt: string; endedAt: string | null; cancelAtPeriodEnd: boolean; cancelReason: string | null }
export type FinTrial = { orgId: string; startedAt: string; endsAt: string | null; endedAt: string | null; outcome: string; convertedAt: string | null }
export type FinFailure = { orgId: string; failedAt: string; amountDueCents: number | null; recoveredAt: string | null }

const REVENUE_STATUS: Record<FinSub['provider'], string[]> = { stripe: ['active', 'past_due'], shopify: ['active'] }
const inRange = (iso: string | null, from: Date, to: Date) => Boolean(iso) && new Date(iso!) >= from && new Date(iso!) < to

export function computeFinance(i: { month: string; plans: FinPlan[]; subs: FinSub[]; trials: FinTrial[]; failures: FinFailure[] }) {
  const [f, t] = monthRange(i.month)
  const from = new Date(`${f}T00:00:00Z`), to = new Date(`${t}T00:00:00Z`)
  const plan = new Map(i.plans.map(p => [p.key, p]))
  const paying = i.subs.filter(s => REVENUE_STATUS[s.provider].includes(s.status))
  const byPlan = new Map<string, { planKey: string; name: string; count: number; mrrCents: number; hypothesis: boolean }>()
  let liveCents = 0, testCents = 0, hypothesisCents = 0, unpriced = 0
  for (const s of paying) {
    const p = s.planKey ? plan.get(s.planKey) : undefined
    if (!p) { unpriced++; continue }
    if (s.livemode) liveCents += p.priceCents; else testCents += p.priceCents
    if (p.status !== 'approved' && s.livemode) hypothesisCents += p.priceCents
    const b = byPlan.get(p.key) ?? { planKey: p.key, name: p.name, count: 0, mrrCents: 0, hypothesis: p.status !== 'approved' }
    b.count++; b.mrrCents += p.priceCents; byPlan.set(p.key, b)
  }
  const priceOf = (s: FinSub) => (s.planKey ? plan.get(s.planKey)?.priceCents ?? 0 : 0)
  const endedTrials = i.trials.filter(x => x.outcome !== 'trialing' && inRange(x.endedAt ?? x.endsAt, from, to))
  const convertedOfEnded = endedTrials.filter(x => x.outcome === 'converted').length
  const churned = i.subs.filter(s => s.status === 'canceled' && inRange(s.endedAt, from, to))
  const atStart = i.subs.filter(s => s.status !== 'incomplete' && new Date(s.createdAt) < from && (!s.endedAt || new Date(s.endedAt) >= from))
  const reasons: Record<string, number> = {}
  for (const s of churned) reasons[s.cancelReason ?? 'not given'] = (reasons[s.cancelReason ?? 'not given'] ?? 0) + 1
  const failed = i.failures.filter(x => inRange(x.failedAt, from, to))
  const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null)
  return {
    month: i.month,
    mrr: {
      liveCents, testCents, hypothesisCents, arrLiveCents: liveCents * 12, arrTestCents: testCents * 12,
      subscriptions: paying.length, unpriced,
      /** true while any MRR comes from a plan whose price is still a hypothesis (or all of it is test mode) */
      pricesAreHypotheses: [...byPlan.values()].some(b => b.hypothesis),
      byPlan: [...byPlan.values()].sort((a, b) => b.mrrCents - a.mrrCents),
    },
    trials: {
      started: i.trials.filter(x => inRange(x.startedAt, from, to)).length,
      ended: endedTrials.length, converted: convertedOfEnded,
      lapsed: endedTrials.filter(x => x.outcome === 'lapsed').length, canceled: endedTrials.filter(x => x.outcome === 'canceled').length,
      conversionPct: ratio(convertedOfEnded, endedTrials.length),
      running: i.trials.filter(x => x.outcome === 'trialing').length,
    },
    churn: {
      churned: churned.length, activeAtStart: atStart.length, churnPct: ratio(churned.length, atStart.length),
      churnedMrrCents: churned.reduce((s, x) => s + priceOf(x), 0), reasons,
      scheduled: i.subs.filter(s => s.cancelAtPeriodEnd && REVENUE_STATUS[s.provider].concat('trialing').includes(s.status)).length,
    },
    failedPayments: {
      attempts: failed.length, orgs: new Set(failed.map(x => x.orgId)).size,
      amountDueCents: failed.reduce((s, x) => s + (x.amountDueCents ?? 0), 0),
      recovered: failed.filter(x => x.recoveredAt).length,
      openNow: new Set(i.failures.filter(x => !x.recoveredAt).map(x => x.orgId)).size,
    },
  }
}
export type FinanceSummary = ReturnType<typeof computeFinance>

export type FinanceOrgRow = OrgEconomics & { provider: string | null; planName: string | null; planPriceCents: number | null; hypothesisPrice: boolean; livemode: boolean | null; mrrCents: number; failedPayments: number; trialOutcome: string | null }

/** The finance report for one month: the summary and one row per merchant organization. Service-role connection. */
export async function financeReport(db: Db, month: string) {
  const [from, to] = monthRange(month)
  const plans = (await db.query<{ key: string; display_name: string; monthly_price_cents: number; currency: string; status: string }>('select key, display_name, monthly_price_cents, currency, status from plans'))
    .map(p => ({ key: p.key, name: p.display_name, priceCents: p.monthly_price_cents, currency: p.currency, status: p.status }))
  const stripe = await db.query<{ org_id: string; name: string; status: string; plan_key: string | null; plan: string | null; livemode: boolean; created_at: string; ended_at: string | null; cancel_at_period_end: boolean; cancel_reason: string | null }>(
    `select b.org_id, g.name, b.status, b.plan_key, b.plan, b.livemode, b.created_at::text, b.ended_at::text, b.cancel_at_period_end, b.cancel_reason
     from billing_subscriptions b join agencies g on g.id = b.org_id where b.provider = 'stripe'`)
  const shopify = await db.query<{ org_id: string; name: string; status: string; plan_key: string; is_test: boolean; created_at: string; updated_at: string }>(
    `select a.org_id, g.name, a.status, a.plan_key, a.is_test, a.created_at::text, a.updated_at::text from app_subscriptions a join agencies g on g.id = a.org_id where a.provider = 'shopify_billing'`)
  const subs: FinSub[] = [
    ...stripe.map(s => ({ orgId: s.org_id, orgName: s.name, provider: 'stripe' as const, status: s.status, planKey: s.plan_key ?? s.plan, livemode: s.livemode, createdAt: new Date(s.created_at).toISOString(), endedAt: s.ended_at ? new Date(s.ended_at).toISOString() : null, cancelAtPeriodEnd: s.cancel_at_period_end, cancelReason: s.cancel_reason })),
    ...shopify.map(s => ({ orgId: s.org_id, orgName: s.name, provider: 'shopify' as const, status: s.status === 'cancelled' ? 'canceled' : s.status, planKey: s.plan_key, livemode: !s.is_test, createdAt: new Date(s.created_at).toISOString(), endedAt: s.status === 'cancelled' ? new Date(s.updated_at).toISOString() : null, cancelAtPeriodEnd: false, cancelReason: null })),
  ]
  const trials = (await db.query<{ org_id: string; started_at: string; ends_at: string | null; ended_at: string | null; outcome: string; converted_at: string | null }>('select org_id, started_at::text, ends_at::text, ended_at::text, outcome, converted_at::text from billing_trials'))
    .map(x => ({ orgId: x.org_id, startedAt: new Date(x.started_at).toISOString(), endsAt: x.ends_at ? new Date(x.ends_at).toISOString() : null, endedAt: x.ended_at ? new Date(x.ended_at).toISOString() : null, outcome: x.outcome, convertedAt: x.converted_at }))
  const failures = (await db.query<{ org_id: string; failed_at: string; amount_due_cents: string | null; recovered_at: string | null }>('select org_id, failed_at::text, amount_due_cents::text, recovered_at::text from billing_payment_failures'))
    .map(x => ({ orgId: x.org_id, failedAt: new Date(x.failed_at).toISOString(), amountDueCents: x.amount_due_cents === null ? null : Number(x.amount_due_cents), recoveredAt: x.recovered_at }))
  const summary = computeFinance({ month, plans, subs, trials, failures })
  const econ = await economicsReport(db, month)
  const planMap = new Map(plans.map(p => [p.key, p]))
  const fromD = new Date(`${from}T00:00:00Z`), toD = new Date(`${to}T00:00:00Z`)
  const orgs: FinanceOrgRow[] = econ.orgs.map(o => {
    const s = subs.filter(x => x.orgId === o.orgId).sort((a, b) => Number(REVENUE_STATUS[b.provider].includes(b.status)) - Number(REVENUE_STATUS[a.provider].includes(a.status)))[0]
    const p = s?.planKey ? planMap.get(s.planKey) : o.plan ? planMap.get(o.plan) : undefined
    const paying = s ? REVENUE_STATUS[s.provider].includes(s.status) : false
    return {
      ...o, provider: s?.provider ?? null, planName: p?.name ?? null, planPriceCents: p?.priceCents ?? null, hypothesisPrice: p ? p.status !== 'approved' : false, livemode: s?.livemode ?? null,
      mrrCents: paying && p ? p.priceCents : 0,
      failedPayments: failures.filter(x => x.orgId === o.orgId && inRange(x.failedAt, fromD, toD)).length,
      trialOutcome: trials.find(x => x.orgId === o.orgId)?.outcome ?? null,
    }
  })
  return { summary, orgs, totals: econ.totals, prices: econ.prices }
}
export type FinanceReport = Awaited<ReturnType<typeof financeReport>>

/** A CSV cell: quoted when needed; a leading =, +, - or @ is neutralized (no formula runs when the file is opened). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : String(v)
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function financeCsv(r: FinanceReport): string {
  const head = ['month', 'organization_id', 'organization', 'provider', 'plan', 'plan_price_usd', 'price_is_hypothesis', 'livemode', 'subscription_status', 'mrr_usd',
    'revenue_usd', 'ai_cost_usd', 'provider_cost_usd', 'email_cost_usd', 'variable_cost_usd', 'gross_margin_pct', 'verified_resolutions', 'cost_per_resolution_usd', 'failed_payments', 'trial_outcome', 'flags']
  const rows = r.orgs.map(o => [r.summary.month, o.orgId, o.orgName, o.provider, o.planName ?? o.plan, o.planPriceCents === null ? null : o.planPriceCents / 100, o.hypothesisPrice, o.livemode, o.subscriptionStatus, o.mrrCents / 100,
    o.revenueUsd, o.aiCostUsd, o.providerCostUsd + o.jobCostUsd, o.emailCostUsd, o.variableCostUsd, o.grossMarginPct, o.verifiedResolutions, o.costPerResolutionUsd, o.failedPayments, o.trialOutcome, o.flags.join(' ')])
  return [head, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
