/**
 * Everything the billing page and the in-app billing banner show, from our own records (no Stripe call:
 * invoices and the payment method come from lib/billing/lifecycle.ts stripeAccount, loaded separately so
 * the page still renders when Stripe is slow).
 */
import type { Db } from '../db'
import { orgEntitlements, monthStart } from '../plans/entitlements'
import { planUsage } from '../plans/allowance'
import { aiSpend } from '../ai/budgets'
import { checkoutRefusal, loadPlans, type PlanSuite } from '../plans/catalog'
import { pricingPlansUrl } from '../connectors/shopify/billing'
import { enabledProducts } from '../products'
import { billingMode, stripeConfig } from './config'
import { priceIdForPlan } from './plans'
import { trialEligibility } from './checkout'
import { billingBanner, type Banner } from './messages'

export type PlanOption = { key: string; name: string; suite: PlanSuite; priceCents: number; currency: string; pilot: boolean; trialDays: number; available: boolean; refusal: string | null; current: boolean; pending: boolean }

export async function billingOverview(db: Db, orgId: string, now = new Date()) {
  const mode = billingMode()
  const e = await orgEntitlements(db, orgId, now)
  const usage = await planUsage(db, orgId, now)
  const ai = await aiSpend(db, orgId, null, monthStart(now).toISOString().slice(0, 10))
  const sub = await db.one<{ status: string; plan_key: string | null; plan: string | null; trial_end: string | null; cancel_reason: string | null; cancel_requested_at: string | null; pending_plan_key: string | null; pending_change_at: string | null; ended_at: string | null }>(
    `select status, plan_key, plan, trial_end::text, cancel_reason, cancel_requested_at::text, pending_plan_key, pending_change_at::text, ended_at::text from billing_subscriptions where org_id = $1 and provider = 'stripe'`, [orgId])
  const failure = await db.one<{ n: string; last_failed_at: string | null; next_attempt_at: string | null; amount_due_cents: string | null; currency: string | null; hosted_invoice_url: string | null }>(
    `select count(*)::text as n, max(failed_at)::text as last_failed_at,
       (array_agg(next_attempt_at order by failed_at desc))[1]::text as next_attempt_at, (array_agg(amount_due_cents order by failed_at desc))[1]::text as amount_due_cents,
       (array_agg(currency order by failed_at desc))[1] as currency, (array_agg(hosted_invoice_url order by failed_at desc))[1] as hosted_invoice_url
     from billing_payment_failures where org_id = $1 and recovered_at is null`, [orgId])
  const customer = await db.one<{ external_id: string; email_hash: string | null }>('select external_id, email_hash from billing_customers where org_id = $1', [orgId])
  const products = await enabledProducts(db, orgId)
  const suites: PlanSuite[] = products.includes('commerce') && products.includes('office') ? ['commerce', 'office', 'both'] : products.includes('office') ? ['office', 'both'] : products.includes('commerce') ? ['commerce', 'both'] : ['commerce', 'office', 'both']
  const currentKey = sub && ['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status) ? (sub.plan_key ?? sub.plan) : null
  const plans: PlanOption[] = (await loadPlans(db)).filter(p => p.active && p.status !== 'retired' && suites.includes(p.suite)).map(p => {
    const refusal = mode === 'off' ? 'billing is off during the free beta' : checkoutRefusal(p, mode) ?? (priceIdForPlan(p) ? null : 'no Stripe price is configured for this plan')
    return { key: p.key, name: p.display_name, suite: p.suite, priceCents: p.monthly_price_cents, currency: p.currency, pilot: p.status === 'hypothesis', trialDays: p.trial_days,
      available: !refusal && stripeConfig.configured, refusal, current: p.key === currentKey, pending: p.key === sub?.pending_plan_key }
  })
  const trial = await db.one<{ outcome: string; started_at: string; ends_at: string | null }>('select outcome, started_at::text, ends_at::text from billing_trials where org_id = $1', [orgId])
  const eligibility = await trialEligibility(db, { orgId, customer: customer?.external_id ?? null, emailHash: customer?.email_hash ?? null })
  const trialDaysLeft = sub?.status === 'trialing' && sub.trial_end ? Math.max(0, Math.ceil((new Date(sub.trial_end).getTime() - now.getTime()) / 86400e3)) : null

  let shopify: { planHandle: string | null; status: string | null; currentPeriodEnd: string | null; isTest: boolean; plansUrl: string | null } | null = null
  if (e.billing.provider === 'shopify' || mode === 'off') {
    const conn = await db.one<{ id: string; external_id: string; is_synthetic: boolean }>(`select id, external_id, is_synthetic from store_connections where org_id = $1 and platform = 'shopify' and status = 'active' order by created_at limit 1`, [orgId])
    if (conn) {
      const s = await db.one<{ plan_key: string; status: string; current_period_end: string | null; is_test: boolean }>(
        `select plan_key, status, current_period_end::text, is_test from app_subscriptions where connection_id = $1 and provider = 'shopify_billing' order by (status = 'active') desc, updated_at desc limit 1`, [conn.id])
      shopify = { planHandle: s?.plan_key ?? null, status: s?.status ?? null, currentPeriodEnd: s?.current_period_end ?? null, isTest: Boolean(s?.is_test), plansUrl: conn.is_synthetic ? null : pricingPlansUrl(conn.external_id) }
    }
  }
  const openFailures = Number(failure?.n ?? 0)
  const banner: Banner = billingBanner({ mode, provider: e.billing.provider, status: e.billing.status, readOnly: e.billing.readOnly, reason: e.billing.reason, graceEndsAt: e.billing.graceEndsAt,
    trialEnd: sub?.trial_end ?? null, cancelAtPeriodEnd: e.billing.cancelAtPeriodEnd, currentPeriodEnd: e.billing.currentPeriodEnd, openFailures }, now)
  return {
    mode, configured: stripeConfig.configured, provider: e.billing.provider, hasPortal: Boolean(customer),
    billing: e.billing,
    subscription: sub ? { status: sub.status, planKey: currentKey, trialEnd: sub.trial_end, trialDaysLeft, cancelReason: sub.cancel_reason, cancelRequestedAt: sub.cancel_requested_at, pendingPlanKey: sub.pending_plan_key, pendingChangeAt: sub.pending_change_at, endedAt: sub.ended_at } : null,
    paymentFailure: openFailures ? { count: openFailures, lastFailedAt: failure!.last_failed_at, nextAttemptAt: failure!.next_attempt_at, amountDueCents: failure!.amount_due_cents === null ? null : Number(failure!.amount_due_cents), currency: failure!.currency, hostedInvoiceUrl: failure!.hosted_invoice_url } : null,
    trial: { eligible: eligibility.eligible, refusal: eligibility.reason, outcome: trial?.outcome ?? null, endsAt: trial?.ends_at ?? null },
    plan: { tier: e.tier, key: e.plan, label: e.label, priced: e.priced, writesAllowed: e.writesAllowed,
      limits: { maxAgents: e.maxAgents, maxCompetitorStores: e.maxCompetitorStores, monthlyActions: e.monthlyActions, monthlyEmails: e.monthlyEmails, officeSeats: e.officeSeats, officeConnections: e.officeConnections, aiBudgetUsd: e.aiBudgetUsd } },
    plans, pricingLabel: plans.some(p => p.pilot) ? 'Pilot pricing' : null,
    usage: { ...usage, aiSpendUsd: Math.round(ai * 100) / 100, aiBudgetUsd: usage.enforced ? e.aiBudgetUsd : null },
    shopify, banner,
  }
}
export type BillingOverview = Awaited<ReturnType<typeof billingOverview>>
