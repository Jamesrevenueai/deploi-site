/**
 * Billing v2: the published catalog (lib/pricing/catalog.json) charged the way each side is billed.
 *
 *   Store (Shopify Billing API)  appSubscriptionCreate with a recurring line item (Starter $79 / Growth $199 / Pro $499,
 *                                every 30 days, 14-day trial) and a usage line item whose cappedAmount is the merchant's
 *                                own overage cap; overage ($5 per 100 actions) is an appUsageRecordCreate against it.
 *                                Yearly is ANNUAL at 10 months' price (2 months free). Shopify does not allow a usage
 *                                line item on an annual subscription, so a yearly plan has no overage: work pauses at
 *                                the allowance (lib/metering capCheck) and the merchant is told.
 *   Office (Stripe Checkout)     Solo $149 / Team $349 / Business $799 as inline prices (price_data: the amounts come
 *                                from the catalog, never invented in Stripe), yearly at 10 months' price, the optional
 *                                $499 setup (Solo, Team; included in Business) as a one-time line, 20% off Office with
 *                                a Store plan. Overage ($5 per 100 actions, $3 per 100 texts) is added as invoice items
 *                                on the customer's next invoice, never above the customer's cap.
 *
 * Overage is charged in whole blocks (100 actions or 100 texts), cumulative per month: usage_charges keeps the blocks
 * already charged, so running the charge twice sends nothing twice (and Shopify/Stripe idempotency keys back that up).
 */
import type { Db } from '../db'
import { HttpError } from '../store/request'
import { audit } from '../engine/audit'
import { CATALOG, OFFICE_ORDER, STORE_ORDER, isOfficePlan, isStorePlan, officePlan, officePriceCents, priceCents, setupFeeCents, storePlan, type Interval, type OfficePlanKey, type StorePlanKey } from '../pricing'
import { usageState } from '../metering'
import { shopifyGraphql } from '../connectors/shopify/client'
import { loadConnection } from '../engine/scan'
import { recordSubscription } from '../connectors/shopify/billing'
import { stripeRequest } from './stripe'
import { billingMode, stripeConfig } from './config'
import { ensureCustomer, viaStripe } from './checkout'

const money = (cents: number) => ({ amount: Number((cents / 100).toFixed(2)), currencyCode: 'USD' })
const monthDate = (month: string) => (/^\d{4}-\d{2}$/.test(month) ? `${month}-01` : month)

// ---------------------------------------------------------------------------------------------------------- Shopify

export const M_SUBSCRIBE = /* GraphQL */ `
  mutation DeploiSubscribe($name: String!, $returnUrl: URL!, $test: Boolean, $trialDays: Int, $lineItems: [AppSubscriptionLineItemInput!]!) {
    appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test, trialDays: $trialDays, lineItems: $lineItems) {
      appSubscription { id status lineItems { id plan { pricingDetails { __typename } } } }
      confirmationUrl
      userErrors { field message }
    }
  }
`

export const M_USAGE_RECORD = /* GraphQL */ `
  mutation DeploiUsageRecord($subscriptionLineItemId: ID!, $price: MoneyInput!, $description: String!, $idempotencyKey: String) {
    appUsageRecordCreate(subscriptionLineItemId: $subscriptionLineItemId, price: $price, description: $description, idempotencyKey: $idempotencyKey) {
      appUsageRecord { id }
      userErrors { field message }
    }
  }
`

/** The overage terms the merchant sees on Shopify's confirmation page. */
export const storeUsageTerms = (plan: StorePlanKey) =>
  `$${CATALOG.store.overage.priceCents / 100} per ${CATALOG.store.overage.unitActions} actions over the ${storePlan(plan).actions.toLocaleString('en-US')} included each month, up to your cap`

/** appSubscriptionCreate variables for a Store plan, from the catalog. */
export function shopifySubscriptionVariables(plan: StorePlanKey, interval: Interval, opts: { capCents: number; test: boolean; returnUrl: string; trial?: boolean }) {
  const p = storePlan(plan)
  const recurring = { plan: { appRecurringPricingDetails: { price: money(priceCents(plan, interval)), interval: interval === 'year' ? 'ANNUAL' : 'EVERY_30_DAYS' } } }
  const lineItems: unknown[] = [recurring]
  if (interval === 'month') {
    if (!Number.isInteger(opts.capCents) || opts.capCents < CATALOG.store.overage.priceCents) throw new HttpError(400, 'invalid_input', `the overage cap must be at least $${CATALOG.store.overage.priceCents / 100}`)
    lineItems.push({ plan: { appUsagePricingDetails: { cappedAmount: money(opts.capCents), terms: storeUsageTerms(plan) } } })
  }
  return { name: `Deploi ${p.name}${interval === 'year' ? ' (yearly)' : ''}`, returnUrl: opts.returnUrl, test: opts.test, trialDays: opts.trial === false ? 0 : CATALOG.store.trialDays, lineItems }
}

type SubscribeResult = { appSubscriptionCreate: { appSubscription: { id: string; status: string; lineItems: { id: string; plan: { pricingDetails: { __typename: string } } }[] } | null; confirmationUrl: string | null; userErrors: { field: string[] | null; message: string }[] } }

/**
 * Start a Store subscription through the Shopify Billing API. Returns Shopify's confirmation URL: the merchant approves
 * the charge (and the capped amount) on Shopify's own page; nothing is billed before that. `test` is forced on outside
 * live billing, so a dev store is never charged.
 */
export async function startShopifySubscription(db: Db, input: { orgId: string; connectionId: string; plan: unknown; interval?: unknown; capCents?: number; returnUrl: string; actor: string }) {
  if (!isStorePlan(input.plan)) throw new HttpError(400, 'invalid_input', `plan must be one of ${STORE_ORDER.join(', ')}`)
  const interval: Interval = input.interval === 'year' ? 'year' : 'month'
  const row = await loadConnection(db, input.connectionId)
  if (!row || row.org_id !== input.orgId) throw new HttpError(404, 'not_found', 'store connection not found')
  const test = billingMode() !== 'live'
  const capCents = input.capCents ?? 5000
  const variables = shopifySubscriptionVariables(input.plan, interval, { capCents, test, returnUrl: input.returnUrl })
  const data = await shopifyGraphql<SubscribeResult>(row, { query: M_SUBSCRIBE, operationName: 'DeploiSubscribe', variables }, { mutation: true })
  const r = data.appSubscriptionCreate
  if (!r.appSubscription || r.userErrors.length) throw new HttpError(422, 'shopify_billing_refused', r.userErrors.map(e => e.message).join('; ').slice(0, 300) || 'Shopify did not create the subscription')
  const usage = r.appSubscription.lineItems.find(l => l.plan.pricingDetails.__typename === 'AppUsagePricing')?.id ?? null
  await recordSubscription(db, { orgId: input.orgId, connectionId: input.connectionId, externalId: r.appSubscription.id, planKey: input.plan, status: r.appSubscription.status, isTest: test, actor: input.actor })
  await db.query('update app_subscriptions set usage_line_item_id = $2, billing_interval = $3 where provider = $4 and external_id = $1', [r.appSubscription.id, usage, interval, 'shopify_billing'])
  if (interval === 'month') await db.query(`insert into org_usage_caps (org_id, action_overage_cap_cents, updated_by) values ($1,$2,$3)
    on conflict (org_id) do update set action_overage_cap_cents = $2, updated_by = $3, updated_at = now()`, [input.orgId, capCents, input.actor.slice(0, 160)])
  return { subscriptionId: r.appSubscription.id, status: r.appSubscription.status, confirmationUrl: r.confirmationUrl, usageLineItemId: usage, test, interval }
}

// ---------------------------------------------------------------------------------------------------------- overage

export type Pending = { kind: 'action' | 'text'; month: string; blocksTotal: number; newBlocks: number; amountCents: number; unit: number; blockCents: number }

/** Overage blocks used this month that are not charged yet (never more than the customer's cap allows). */
export async function pendingOverage(db: Db, orgId: string, now = new Date()): Promise<Pending[]> {
  const s = await usageState(db, orgId, now)
  const out: Pending[] = []
  const add = (kind: 'action' | 'text', over: number, allowed: number, unit: number, blockCents: number, charged: number) => {
    const blocksTotal = Math.min(Math.ceil(over / unit), Math.floor(allowed / unit))
    if (blocksTotal > charged) out.push({ kind, month: s.month, blocksTotal, newBlocks: blocksTotal - charged, amountCents: (blocksTotal - charged) * blockCents, unit, blockCents })
  }
  const charged = async (kind: string) => (await db.one<{ n: number }>('select coalesce(max(blocks_total), 0)::int as n from usage_charges where org_id = $1 and month = $2 and kind = $3', [orgId, monthDate(s.month), kind]))!.n
  if (isOfficePlan(s.plan)) {
    const o = CATALOG.office.overage
    add('action', s.actions.overage, s.actions.overageAllowed, o.unitActions, o.actionPriceCents, await charged('action'))
    if (s.texts) add('text', s.texts.overage, s.texts.overageAllowed, o.unitTexts, o.textPriceCents, await charged('text'))
  } else {
    const o = CATALOG.store.overage
    add('action', s.actions.overage, s.actions.overageAllowed, o.unitActions, o.priceCents, await charged('action'))
  }
  return out
}

const describe = (p: Pending) => `Deploi overage ${p.month}: ${p.newBlocks * p.unit} ${p.kind === 'text' ? 'texts' : 'actions'} over the plan (${p.newBlocks} x $${p.blockCents / 100} per ${p.unit})`

/** Charge this month's uncharged overage: a Shopify usage record (Store) or Stripe invoice items (Office). */
export async function chargeOverage(db: Db, orgId: string, opts: { now?: Date; fetchImpl?: typeof fetch; actor?: string } = {}) {
  if (billingMode() === 'off') return { charged: [] as Pending[], skipped: 'billing is off' }
  const pending = await pendingOverage(db, orgId, opts.now)
  if (!pending.length) return { charged: [], skipped: null }
  const charged: (Pending & { externalId: string })[] = []
  const store = await db.one<{ connection_id: string; usage_line_item_id: string | null }>(`select connection_id, usage_line_item_id from app_subscriptions
    where org_id = $1 and provider = 'shopify_billing' and status = 'active' order by updated_at desc limit 1`, [orgId])
  for (const p of pending) {
    const key = `deploi-overage-${orgId}-${p.month}-${p.kind}-${p.blocksTotal}`
    let externalId: string
    if (store) {
      if (!store.usage_line_item_id) continue // a yearly Shopify plan has no usage line: work paused at the allowance instead
      const row = await loadConnection(db, store.connection_id)
      if (!row) continue
      const data = await shopifyGraphql<{ appUsageRecordCreate: { appUsageRecord: { id: string } | null; userErrors: { message: string }[] } }>(row,
        { query: M_USAGE_RECORD, operationName: 'DeploiUsageRecord', variables: { subscriptionLineItemId: store.usage_line_item_id, price: money(p.amountCents), description: describe(p), idempotencyKey: key.slice(0, 255) } }, { mutation: true })
      const r = data.appUsageRecordCreate
      if (!r.appUsageRecord) throw new HttpError(422, 'shopify_billing_refused', r.userErrors.map(e => e.message).join('; ').slice(0, 300) || 'Shopify refused the usage charge')
      externalId = r.appUsageRecord.id
    } else {
      if (!stripeConfig.configured) throw new HttpError(503, 'billing_not_configured', 'billing is not configured in this environment')
      const customer = await db.one<{ external_id: string }>('select external_id from billing_customers where org_id = $1', [orgId])
      if (!customer) continue
      const item = await viaStripe(() => stripeRequest<{ id: string }>('POST', '/v1/invoiceitems', { customer: customer.external_id, amount: p.amountCents, currency: 'usd', description: describe(p), metadata: { org_id: orgId, month: p.month, kind: p.kind, blocks_total: String(p.blocksTotal) } },
        { idempotencyKey: key, fetchImpl: opts.fetchImpl }))
      externalId = item.id
    }
    await db.query(`insert into usage_charges (org_id, month, kind, provider, blocks_total, amount_cents, external_id) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
      [orgId, monthDate(p.month), p.kind, store ? 'shopify' : 'stripe', p.blocksTotal, p.amountCents, externalId])
    await audit(db, { orgId, entityType: 'subscription', entityId: externalId, event: 'billing.overage_charged', actor: opts.actor ?? 'system:overage', detail: { kind: p.kind, month: p.month, blocks: p.newBlocks, amount_cents: p.amountCents, provider: store ? 'shopify' : 'stripe' } })
    charged.push({ ...p, externalId })
  }
  return { charged, skipped: null }
}

// ---------------------------------------------------------------------------------------------------------- Office / Stripe

export type OfficeQuote = { plan: OfficePlanKey; interval: Interval; recurringCents: number; setupCents: number; bundle: boolean; todayCents: number; trialDays: number }

/** What an Office plan costs: the catalog price, yearly at 10 months, minus 20% with a Store plan, plus the optional setup. */
export function officeQuote(plan: OfficePlanKey, interval: Interval, opts: { hasStore: boolean; setup: boolean }): OfficeQuote {
  const recurringCents = officePriceCents(plan, interval, opts.hasStore)
  const setupCents = opts.setup ? setupFeeCents(plan) : 0
  return { plan, interval, recurringCents, setupCents, bundle: opts.hasStore, todayCents: setupCents, trialDays: CATALOG.office.trialDays }
}

/** The Stripe Checkout Session body for an Office plan (inline prices from the catalog). */
export function officeCheckoutBody(input: { orgId: string; customer: string; quote: OfficeQuote; appUrl: string }) {
  const { quote: q } = input
  const p = officePlan(q.plan)
  const base = input.appUrl.replace(/\/$/, '')
  const meta = { org_id: input.orgId, plan: p.key === 'solo' ? 'starter' : p.key === 'team' ? 'growth' : 'pro', plan_key: p.key, interval: q.interval, bundle: q.bundle ? 'store' : 'none' }
  const line_items: unknown[] = [{
    quantity: 1,
    price_data: { currency: 'usd', unit_amount: q.recurringCents, recurring: { interval: q.interval }, product_data: { name: `Deploi Office ${p.name}${q.bundle ? ' (20% off with Store)' : ''}`, metadata: { plan_key: p.key } } },
  }]
  if (q.setupCents) line_items.push({ quantity: 1, price_data: { currency: 'usd', unit_amount: q.setupCents, product_data: { name: 'Deploi Office setup (done with you)' } } })
  return {
    mode: 'subscription', customer: input.customer, client_reference_id: input.orgId, line_items,
    success_url: `${base}/store/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/store/billing?checkout=cancelled`,
    metadata: meta,
    subscription_data: { metadata: meta, ...(q.trialDays ? { trial_period_days: q.trialDays } : {}) },
  }
}

/** Start an Office subscription in Stripe Checkout (test keys outside production). */
export async function createOfficeCheckout(db: Db, input: { orgId: string; plan: unknown; interval?: unknown; setup?: boolean; email?: string | null; appUrl: string; actor: string; fetchImpl?: typeof fetch }) {
  if (billingMode() === 'off') throw new HttpError(409, 'billing_off', 'billing is not switched on yet')
  if (!stripeConfig.configured) throw new HttpError(503, 'billing_not_configured', 'billing is not configured in this environment')
  if (!isOfficePlan(input.plan)) throw new HttpError(400, 'invalid_input', `plan must be one of ${OFFICE_ORDER.join(', ')}`)
  const interval: Interval = input.interval === 'year' ? 'year' : 'month'
  const hasStore = Boolean(await db.one(`select 1 from app_subscriptions where org_id = $1 and provider = 'shopify_billing' and status = 'active' and plan_key = any($2)`, [input.orgId, STORE_ORDER]))
  const quote = officeQuote(input.plan, interval, { hasStore, setup: Boolean(input.setup) })
  const customer = await viaStripe(() => ensureCustomer(db, input.orgId, { email: input.email, fetchImpl: input.fetchImpl }))
  const body = officeCheckoutBody({ orgId: input.orgId, customer, quote, appUrl: input.appUrl })
  const bucket = Math.floor(Date.now() / 600e3)
  const s = await viaStripe(() => stripeRequest<{ id: string; url: string }>('POST', '/v1/checkout/sessions', body, { idempotencyKey: `deploi-office-${input.orgId}-${quote.plan}-${interval}-${quote.setupCents}-${hasStore}-${bucket}`, fetchImpl: input.fetchImpl }))
  if (!s.url || !/^https:\/\/checkout\.stripe\.com\//.test(s.url)) throw new HttpError(502, 'stripe_error', 'unexpected checkout URL from Stripe')
  await audit(db, { orgId: input.orgId, entityType: 'subscription', entityId: s.id, event: 'billing.checkout_started', actor: input.actor, detail: { provider: 'stripe', plan_key: quote.plan, interval, setup_cents: quote.setupCents, bundle: hasStore } })
  return { id: s.id, url: s.url, quote }
}
