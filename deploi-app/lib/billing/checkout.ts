/**
 * Starting and managing a Stripe subscription: Checkout Session (mode subscription) and the Stripe
 * customer portal. The caller has already resolved the actor's organization from the session; these run
 * as the service role for that organization only.
 */
import { createHash } from 'node:crypto'
import type { Db } from '../db'
import { HttpError } from '../store/request'
import { audit } from '../engine/audit'
import { isTierKey, type TierKey } from '../library/config'
import { pricingPlansUrl } from '../connectors/shopify/billing'
import { billingMode, priceIdFor, stripeConfig } from './config'
import { StripeError, stripeFailureMessage, stripeRequest } from './stripe'
import { checkoutRefusal, planByKey, type PlanRow } from '../plans/catalog'
import { billingProviderFor, subscriptionOf } from './state'
import { priceIdForPlan } from './plans'

type FetchOpt = { fetchImpl?: typeof fetch }

/** Run Stripe calls and turn a Stripe failure into an honest API error (card, rate limit, outage). */
export async function viaStripe<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (e) {
    if (e instanceof StripeError) { const m = stripeFailureMessage(e); throw new HttpError(m.status, m.code, m.message) }
    throw e
  }
}

/** Normalized SHA-256 of a billing e-mail address (one trial per address; the address itself is not stored here). */
export function emailHash(email: string | null | undefined): string | null {
  const e = (email ?? '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return null
  const [local, domain] = e.split('@')
  // plus-addressing is the same mailbox
  return createHash('sha256').update(`${local.split('+')[0]}@${domain}`).digest('hex')
}

export type TrialEligibility = { eligible: boolean; reason: string | null }

/**
 * One trial per organization, per Stripe customer and per e-mail address: refused when any of them already
 * had a trial, or when the organization already had a subscription that started.
 */
export async function trialEligibility(db: Db, input: { orgId: string; customer?: string | null; emailHash?: string | null }): Promise<TrialEligibility> {
  const t = await db.one<{ org: boolean; cust: boolean; mail: boolean }>(
    `select exists (select 1 from billing_trials where org_id = $1) as org,
            exists (select 1 from billing_trials where $2::text is not null and customer_external_id = $2) as cust,
            exists (select 1 from billing_trials where $3::text is not null and email_hash = $3) as mail`, [input.orgId, input.customer ?? null, input.emailHash ?? null])
  if (t?.org) return { eligible: false, reason: 'this organization already had its trial' }
  if (t?.cust || t?.mail) return { eligible: false, reason: 'a trial was already used with this billing account' }
  const prior = await db.one<{ id: string }>(`select id from billing_subscriptions where org_id = $1 and provider = 'stripe' and status <> 'incomplete'`, [input.orgId])
  if (prior) return { eligible: false, reason: 'this organization already had a subscription' }
  return { eligible: true, reason: null }
}

function assertStripeBilling() {
  if (billingMode() === 'off') throw new HttpError(409, 'billing_off', 'billing is not switched on yet: the private beta is free')
  if (!stripeConfig.configured) throw new HttpError(503, 'billing_not_configured', 'billing is not configured in this environment')
}

/** Shopify App Store merchants must pay through Shopify: refuse Stripe and point them at Shopify's plan page. */
async function assertStripeProvider(db: Db, orgId: string) {
  if ((await billingProviderFor(db, orgId)) === 'stripe') return
  const shop = await db.one<{ external_id: string }>(`select external_id from store_connections where org_id = $1 and platform = 'shopify' and status = 'active' order by created_at limit 1`, [orgId])
  const url = shop ? pricingPlansUrl(shop.external_id) : null
  throw new HttpError(409, 'use_shopify_billing', `this store is billed through Shopify${url ? `: choose a plan at ${url}` : '; choose a plan in the Shopify admin'}`)
}

/** Reuse the organization's Stripe customer, or create one (idempotent per organization). */
export async function ensureCustomer(db: Db, orgId: string, opts: FetchOpt & { email?: string | null } = {}): Promise<string> {
  const hash = emailHash(opts.email)
  const existing = await db.one<{ external_id: string }>('select external_id from billing_customers where org_id = $1', [orgId])
  if (existing) {
    if (hash) await db.query('update billing_customers set email_hash = coalesce(email_hash, $2) where org_id = $1', [orgId, hash])
    return existing.external_id
  }
  const org = await db.one<{ name: string }>('select name from agencies where id = $1', [orgId])
  if (!org) throw new HttpError(404, 'not_found', 'organization not found')
  const c = await stripeRequest<{ id: string; livemode: boolean }>('POST', '/v1/customers', { name: org.name.slice(0, 200), email: opts.email ?? undefined, metadata: { org_id: orgId } },
    { idempotencyKey: `deploi-customer-${orgId}`, fetchImpl: opts.fetchImpl })
  if (!/^cus_[A-Za-z0-9]+$/.test(c.id)) throw new HttpError(502, 'stripe_error', 'unexpected customer id from Stripe')
  await db.query(`insert into billing_customers (org_id, external_id, livemode, email_hash) values ($1,$2,$3,$4) on conflict (org_id) do nothing`, [orgId, c.id, Boolean(c.livemode), hash])
  return (await db.one<{ external_id: string }>('select external_id from billing_customers where org_id = $1', [orgId]))!.external_id
}

/** Idempotency key for a checkout: the same organization, plan and price within ten minutes reuse one session. */
export function checkoutIdempotencyKey(orgId: string, plan: TierKey | string, priceId: string, now = new Date()) {
  const bucket = Math.floor(now.getTime() / 600e3)
  return `deploi-checkout-${createHash('sha256').update(`${orgId}|${plan}|${priceId}|${bucket}`).digest('hex').slice(0, 40)}`
}

export async function createCheckoutSession(db: Db, input: { orgId: string; plan: unknown; email?: string | null; actor: string; appUrl: string; now?: Date } & FetchOpt) {
  assertStripeBilling()
  // a plan from the plans table (lib/plans/catalog.ts), or one of the library tiers
  const row: PlanRow | null = typeof input.plan === 'string' ? await planByKey(input.plan, db) : null
  if (!row && !isTierKey(input.plan)) throw new HttpError(400, 'invalid_input', 'plan must be one of the plans on sale')
  const plan: TierKey = row?.tier_key ?? input.plan as TierKey
  // owner approval before any price is final: a hypothesis is sold in Stripe test mode only
  const refused = row ? checkoutRefusal(row, billingMode()) : billingMode() === 'live' ? `the ${plan} plan has no approved price record` : null
  if (refused) throw new HttpError(409, 'plan_not_approved', refused)
  const price = row ? priceIdForPlan(row) : priceIdFor(plan)
  if (!price) throw new HttpError(503, 'billing_not_configured', `no Stripe price is configured for the ${row?.key ?? plan} plan`)
  const planMeta: Record<string, string> = row ? { plan, plan_key: row.key } : { plan }
  await assertStripeProvider(db, input.orgId)
  const sub = await subscriptionOf(db, input.orgId, 'stripe')
  if (sub && ['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status)) throw new HttpError(409, 'already_subscribed', 'this organization already has a subscription: change or cancel it on the billing page')
  const customer = await viaStripe(() => ensureCustomer(db, input.orgId, { email: input.email, fetchImpl: input.fetchImpl }))
  // the plan's trial (plans.trial_days), once per organization, customer and e-mail
  const hash = (await db.one<{ email_hash: string | null }>('select email_hash from billing_customers where org_id = $1', [input.orgId]))?.email_hash ?? emailHash(input.email)
  const trialDays = row?.trial_days ?? 0
  const trial = trialDays > 0 ? await trialEligibility(db, { orgId: input.orgId, customer, emailHash: hash }) : { eligible: false, reason: null }
  const withTrial = trialDays > 0 && trial.eligible
  const base = input.appUrl.replace(/\/$/, '')
  const s = await viaStripe(() => stripeRequest<{ id: string; url: string }>('POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    customer,
    client_reference_id: input.orgId,
    line_items: [{ price, quantity: 1 }],
    success_url: `${base}/store/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/store/billing?checkout=cancelled`,
    metadata: { org_id: input.orgId, ...planMeta },
    // a trial needs no card up front; at its end Stripe invoices, and without a payment method the
    // subscription goes past due: the grace period, then read-only (lib/billing/state.ts)
    ...(withTrial ? { payment_method_collection: 'if_required' } : {}),
    subscription_data: {
      metadata: { org_id: input.orgId, ...planMeta },
      ...(withTrial ? { trial_period_days: trialDays, trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } } } : {}),
    },
  }, { idempotencyKey: checkoutIdempotencyKey(input.orgId, `${row?.key ?? plan}${withTrial ? ':trial' : ''}`, price, input.now), fetchImpl: input.fetchImpl }))
  if (!s.url || !/^https:\/\/checkout\.stripe\.com\//.test(s.url)) throw new HttpError(502, 'stripe_error', 'unexpected checkout URL from Stripe')
  await audit(db, { orgId: input.orgId, entityType: 'subscription', entityId: s.id, event: 'billing.checkout_started', actor: input.actor,
    detail: { plan, plan_key: row?.key ?? null, plan_status: row?.status ?? null, provider: 'stripe', trial_days: withTrial ? trialDays : 0, trial_refused: trialDays > 0 && !trial.eligible ? trial.reason : null } })
  return { id: s.id, url: s.url, trialDays: withTrial ? trialDays : 0, trialRefused: trialDays > 0 && !trial.eligible ? trial.reason : null }
}

export async function createPortalSession(db: Db, input: { orgId: string; actor: string; appUrl: string } & FetchOpt) {
  assertStripeBilling()
  await assertStripeProvider(db, input.orgId)
  const c = await db.one<{ external_id: string }>('select external_id from billing_customers where org_id = $1', [input.orgId])
  if (!c) throw new HttpError(409, 'no_customer', 'start a subscription first')
  const s = await viaStripe(() => stripeRequest<{ id: string; url: string }>('POST', '/v1/billing_portal/sessions', { customer: c.external_id, return_url: `${input.appUrl.replace(/\/$/, '')}/store/billing` }, { idempotencyKey: `deploi-portal-${input.orgId}-${Math.floor(Date.now() / 60e3)}`, fetchImpl: input.fetchImpl }))
  if (!s.url || !/^https:\/\/billing\.stripe\.com\//.test(s.url)) throw new HttpError(502, 'stripe_error', 'unexpected portal URL from Stripe')
  await audit(db, { orgId: input.orgId, entityType: 'subscription', entityId: s.id, event: 'billing.portal_opened', actor: input.actor })
  return { url: s.url }
}

/**
 * Cancel the organization's Stripe subscription at once (organization deletion). No-op without one or with
 * billing off. Shopify-billed stores are cancelled by Shopify when the app is uninstalled.
 */
export async function cancelStripeSubscription(db: Db, orgId: string, opts: FetchOpt & { actor: string; reason: string }): Promise<'cancelled' | 'none' | 'billing_off'> {
  if (billingMode() === 'off' || !stripeConfig.configured) return 'billing_off'
  const sub = await subscriptionOf(db, orgId, 'stripe')
  if (!sub?.external_id || ['canceled'].includes(sub.status) || !/^sub_[A-Za-z0-9]+$/.test(sub.external_id)) return 'none'
  await stripeRequest('DELETE', `/v1/subscriptions/${sub.external_id}`, { cancellation_details: { comment: opts.reason.slice(0, 200) } }, { idempotencyKey: `deploi-cancel-${sub.external_id}`, fetchImpl: opts.fetchImpl })
  await db.query(`update billing_subscriptions set status = 'canceled', cancel_at_period_end = false where org_id = $1 and provider = 'stripe'`, [orgId])
  await audit(db, { orgId, entityType: 'subscription', entityId: sub.external_id, event: 'billing.cancelled', actor: opts.actor, detail: { provider: 'stripe', reason: opts.reason } })
  return 'cancelled'
}
