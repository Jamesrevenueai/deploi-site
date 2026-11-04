/**
 * Stripe webhook events -> billing_subscriptions. Runs as the service role inside one transaction per
 * event: the event id is claimed in billing_events first, so a redelivered event is a no-op, and a
 * failure rolls the claim back so Stripe's retry processes it again.
 *
 * Handled: checkout.session.completed, customer.subscription.created/updated/deleted,
 * invoice.payment_failed, invoice.paid. Everything else is recorded as ignored.
 * Out-of-order deliveries: a subscription event older than the last one applied is ignored.
 */
import type { Db } from '../db'
import { audit } from '../engine/audit'
import { isTierKey, type TierKey } from '../library/config'
import { planForPrice } from './config'
import type { SubscriptionStatus } from './state'

export type StripeEvent = { id: string; type: string; created: number; livemode: boolean; data: { object: Record<string, unknown> } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
const idOf = (v: unknown) => str(v) ?? (v && typeof v === 'object' ? str((v as { id?: unknown }).id) : null)
const ts = (v: unknown) => (typeof v === 'number' && v > 0 ? new Date(v * 1000).toISOString() : null)

export function isStripeEvent(v: unknown): v is StripeEvent {
  const e = v as StripeEvent
  return Boolean(e && typeof e.id === 'string' && /^evt_[A-Za-z0-9_]+$/.test(e.id) && typeof e.type === 'string' && typeof e.created === 'number' && e.data && typeof e.data.object === 'object' && e.data.object)
}

/** Stripe subscription status -> ours (incomplete_expired is a subscription that never started). */
export function mapStripeStatus(s: unknown): SubscriptionStatus {
  switch (s) {
    case 'trialing': case 'active': case 'past_due': case 'unpaid': case 'canceled': case 'paused': case 'incomplete': return s
    case 'incomplete_expired': return 'canceled'
    default: return 'incomplete'
  }
}

async function orgForCustomer(db: Db, customer: string | null): Promise<string | null> {
  if (!customer) return null
  return (await db.one<{ org_id: string }>('select org_id from billing_customers where external_id = $1', [customer]))?.org_id ?? null
}

async function orgExists(db: Db, orgId: string | null): Promise<string | null> {
  if (!orgId || !UUID.test(orgId)) return null
  return (await db.one<{ id: string }>('select id from agencies where id = $1', [orgId]))?.id ?? null
}

type Outcome = { outcome: 'processed' | 'ignored'; orgId: string | null; detail: string }

async function onCheckoutCompleted(db: Db, ev: StripeEvent): Promise<Outcome> {
  const s = ev.data.object
  if (s.mode !== 'subscription') return { outcome: 'ignored', orgId: null, detail: 'not a subscription checkout' }
  const customer = idOf(s.customer)
  // the organization comes from client_reference_id (set by us at checkout), cross-checked with the customer we created
  const orgId = await orgExists(db, str(s.client_reference_id))
  if (!orgId) return { outcome: 'ignored', orgId: null, detail: 'unknown client_reference_id' }
  const known = await orgForCustomer(db, customer)
  if (known && known !== orgId) return { outcome: 'ignored', orgId, detail: 'customer belongs to another organization' }
  if (customer && !known) await db.query(`insert into billing_customers (org_id, external_id, livemode) values ($1,$2,$3) on conflict do nothing`, [orgId, customer, ev.livemode])
  const md = (s.metadata ?? {}) as Record<string, unknown>
  const plan: TierKey | null = isTierKey(md.plan) ? md.plan : null
  const subId = idOf(s.subscription)
  // never downgrade a status a subscription event already set: only fill in what is missing
  await db.query(
    `insert into billing_subscriptions (org_id, provider, external_id, customer_external_id, status, plan, livemode)
     values ($1,'stripe',$2,$3,'incomplete',$4,$5)
     on conflict (org_id, provider) do update set external_id = coalesce(billing_subscriptions.external_id, excluded.external_id),
       customer_external_id = coalesce(billing_subscriptions.customer_external_id, excluded.customer_external_id), plan = coalesce(billing_subscriptions.plan, excluded.plan)`,
    [orgId, subId, customer, plan, ev.livemode])
  // last_event_at is left to subscription events: the subscription is created before checkout completes,
  // so its created event must not look older than this one
  return { outcome: 'processed', orgId, detail: 'checkout completed' }
}

async function onSubscription(db: Db, ev: StripeEvent): Promise<Outcome> {
  const sub = ev.data.object
  const subId = str(sub.id)
  const customer = idOf(sub.customer)
  const md = (sub.metadata ?? {}) as Record<string, unknown>
  const byCustomer = await orgForCustomer(db, customer)
  const byMeta = await orgExists(db, str(md.org_id))
  // the customer mapping we created is authoritative; metadata is used only when no customer mapping exists yet
  const orgId = byCustomer ?? byMeta
  if (!orgId || !subId) return { outcome: 'ignored', orgId: null, detail: 'subscription for an unknown customer' }
  if (byCustomer && byMeta && byCustomer !== byMeta) return { outcome: 'ignored', orgId, detail: 'metadata organization does not match the customer' }
  const prior = await db.one<{ status: SubscriptionStatus; last_event_at: string | null; external_id: string | null; past_due_since: string | null }>(
    `select status, last_event_at::text, external_id, past_due_since::text from billing_subscriptions where org_id = $1 and provider = 'stripe'`, [orgId])
  if (prior?.last_event_at && new Date(prior.last_event_at).getTime() > ev.created * 1000) return { outcome: 'ignored', orgId, detail: 'older than the last applied event' }
  if (prior?.external_id && prior.external_id !== subId && ['active', 'trialing', 'past_due'].includes(prior.status) && ev.type !== 'customer.subscription.created')
    return { outcome: 'ignored', orgId, detail: 'event for a subscription that is not the current one' }
  const items = ((sub.items as { data?: { price?: { id?: string }; current_period_end?: number }[] } | undefined)?.data) ?? []
  const plan = planForPrice(items[0]?.price?.id) ?? (isTierKey(md.plan) ? md.plan : null)
  const status = ev.type === 'customer.subscription.deleted' ? 'canceled' : mapStripeStatus(sub.status)
  // current_period_end moved from the subscription to its items in newer API versions; read either
  const periodEnd = ts(sub.current_period_end) ?? ts(items[0]?.current_period_end)
  const pastDueSince = status === 'past_due' ? (prior?.status === 'past_due' && prior.past_due_since ? prior.past_due_since : new Date(ev.created * 1000).toISOString()) : null
  await db.query(
    `insert into billing_subscriptions (org_id, provider, external_id, customer_external_id, status, plan, current_period_end, cancel_at_period_end, trial_end, past_due_since, livemode, last_event_at)
     values ($1,'stripe',$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11))
     on conflict (org_id, provider) do update set external_id = excluded.external_id, customer_external_id = excluded.customer_external_id, status = excluded.status,
       plan = coalesce(excluded.plan, billing_subscriptions.plan), current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
       trial_end = excluded.trial_end, past_due_since = excluded.past_due_since, livemode = excluded.livemode, last_event_at = excluded.last_event_at`,
    [orgId, subId, customer, status, plan, periodEnd, sub.cancel_at_period_end === true, ts(sub.trial_end), pastDueSince, ev.livemode, ev.created])
  // the library tier follows a paying subscription (upgrades and downgrades take effect when Stripe confirms them)
  if (plan && (status === 'active' || status === 'trialing')) await db.query(`update agencies set plan_tier = $2, plan_changed_at = now() where id = $1 and plan_tier is distinct from $2`, [orgId, plan])
  await audit(db, { orgId, entityType: 'subscription', entityId: subId, event: `subscription.${status}`, actor: 'stripe:webhook', detail: { provider: 'stripe', plan, event: ev.type, cancel_at_period_end: sub.cancel_at_period_end === true } })
  return { outcome: 'processed', orgId, detail: `subscription ${status}` }
}

async function onInvoice(db: Db, ev: StripeEvent): Promise<Outcome> {
  const inv = ev.data.object
  const customer = idOf(inv.customer)
  const orgId = await orgForCustomer(db, customer)
  if (!orgId) return { outcome: 'ignored', orgId: null, detail: 'invoice for an unknown customer' }
  // the subscription id sits at the top level in older API versions and under parent.subscription_details in newer ones
  const parent = (inv.parent ?? {}) as { subscription_details?: { subscription?: unknown } }
  const subId = idOf(inv.subscription) ?? idOf(parent.subscription_details?.subscription)
  const row = await db.one<{ external_id: string | null; status: SubscriptionStatus }>(`select external_id, status from billing_subscriptions where org_id = $1 and provider = 'stripe'`, [orgId])
  if (!row || (subId && row.external_id && row.external_id !== subId)) return { outcome: 'ignored', orgId, detail: 'invoice for a subscription that is not the current one' }
  if (ev.type === 'invoice.payment_failed') {
    // start the grace period now if the subscription event has not already
    await db.query(`update billing_subscriptions set status = case when status in ('active','trialing') then 'past_due' else status end,
       past_due_since = coalesce(past_due_since, to_timestamp($2)) where org_id = $1 and provider = 'stripe' and status in ('active','trialing','past_due')`, [orgId, ev.created])
    await audit(db, { orgId, entityType: 'subscription', entityId: subId, event: 'billing.payment_failed', actor: 'stripe:webhook', detail: { attempt_count: inv.attempt_count ?? null } })
    return { outcome: 'processed', orgId, detail: 'payment failed: grace period started' }
  }
  // invoice.paid: a past_due subscription recovers
  await db.query(`update billing_subscriptions set status = case when status in ('past_due','unpaid') then 'active' else status end, past_due_since = null where org_id = $1 and provider = 'stripe'`, [orgId])
  await audit(db, { orgId, entityType: 'subscription', entityId: subId, event: 'billing.invoice_paid', actor: 'stripe:webhook' })
  return { outcome: 'processed', orgId, detail: 'invoice paid' }
}

export async function handleStripeEvent(db: Db, ev: StripeEvent): Promise<{ duplicate: boolean } & Partial<Outcome>> {
  const claimed = await db.one<{ id: string }>(`insert into billing_events (id, type, livemode) values ($1,$2,$3) on conflict (id) do nothing returning id`, [ev.id, ev.type.slice(0, 100), ev.livemode])
  if (!claimed) return { duplicate: true }
  let r: Outcome
  switch (ev.type) {
    case 'checkout.session.completed': r = await onCheckoutCompleted(db, ev); break
    case 'customer.subscription.created': case 'customer.subscription.updated': case 'customer.subscription.deleted': r = await onSubscription(db, ev); break
    case 'invoice.payment_failed': case 'invoice.paid': r = await onInvoice(db, ev); break
    default: r = { outcome: 'ignored', orgId: null, detail: 'event type not handled' }
  }
  await db.query(`update billing_events set outcome = $2, org_id = $3, detail = $4, processed_at = now() where id = $1`, [ev.id, r.outcome, r.orgId, r.detail.slice(0, 300)])
  return { duplicate: false, ...r }
}
