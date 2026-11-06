/**
 * Stripe webhook events -> billing_subscriptions. Runs as the service role inside one transaction per
 * event: the event id is claimed in billing_events first, so a redelivered event is a no-op, and a
 * failure rolls the claim back so Stripe's retry processes it again.
 *
 * Handled: checkout.session.completed, customer.subscription.created/updated/deleted/paused/resumed/
 * trial_will_end, invoice.payment_failed, invoice.paid. Everything else is recorded as ignored.
 * Out-of-order deliveries: a subscription event older than the last one applied for that subscription is
 * ignored, and so is an invoice event older than the last invoice event applied (a late failure never
 * undoes a newer payment). Notices to the owner are queued in the same transaction (lib/billing/notify.ts)
 * and sent after it commits.
 * After each processed event the organization is brought within the plan that now applies (lib/plans/enforce.ts).
 */
import type { Db } from '../db'
import { audit } from '../engine/audit'
import { isTierKey, type TierKey } from '../library/config'
import { planForPrice, stripeConfig } from './config'
import type { SubscriptionStatus } from './state'
import { planForStripePrice } from './plans'
import { billingPageLink, portalLink, queueNotice } from './notify'
import { canceledNotice, cancelScheduledNotice, paymentFailedNotice, paymentRecoveredNotice, planChangedNotice, readOnlyNotice, trialEndingNotice } from './messages'

/** Stripe's cancellation feedback values (cancellation_details.feedback). */
export const CANCEL_REASONS = ['too_expensive', 'missing_features', 'switched_service', 'unused', 'customer_service', 'too_complex', 'low_quality', 'other'] as const
export type CancelReason = (typeof CANCEL_REASONS)[number]

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
  // a plan from the plans table chosen at checkout (its limits apply; the tier above decides the library agents)
  if (typeof md.plan_key === 'string' && /^[a-z][a-z0-9_]{1,40}$/.test(md.plan_key)) await db.query(`update agencies set plan_key = $2 where id = $1 and exists (select 1 from plans where key = $2)`, [orgId, md.plan_key])
  // last_event_at is left to subscription events: the subscription is created before checkout completes,
  // so its created event must not look older than this one
  return { outcome: 'processed', orgId, detail: 'checkout completed' }
}

type PriorSub = { status: SubscriptionStatus; last_event_at: string | null; external_id: string | null; past_due_since: string | null; plan_key: string | null; cancel_at_period_end: boolean; current_period_end: string | null }

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
  // one subscription row per organization: serialize its events
  await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 4213))`, [`billing-sub:${orgId}`])
  const prior = await db.one<PriorSub>(
    `select status, last_event_at::text, external_id, past_due_since::text, plan_key, cancel_at_period_end, current_period_end::text from billing_subscriptions where org_id = $1 and provider = 'stripe'`, [orgId])
  // ordering: an event older than the last one applied for this subscription changes nothing
  if (prior?.last_event_at && prior.external_id === subId && new Date(prior.last_event_at).getTime() > ev.created * 1000) return { outcome: 'ignored', orgId, detail: 'older than the last applied event' }
  if (prior?.external_id && prior.external_id !== subId && ['active', 'trialing', 'past_due'].includes(prior.status) && ev.type !== 'customer.subscription.created')
    return { outcome: 'ignored', orgId, detail: 'event for a subscription that is not the current one' }
  if (ev.type === 'customer.subscription.trial_will_end') return onTrialWillEnd(db, orgId, sub, ev)
  const items = ((sub.items as { data?: { id?: string; price?: { id?: string }; current_period_end?: number }[] } | undefined)?.data) ?? []
  const priceId = str(items[0]?.price?.id)
  const row = await planForStripePrice(db, priceId)
  const metaKey = typeof md.plan_key === 'string' && /^[a-z][a-z0-9_]{1,40}$/.test(md.plan_key) ? md.plan_key : null
  const planKey = row?.key ?? (metaKey && (await db.one('select 1 from plans where key = $1', [metaKey])) ? metaKey : null)
  const plan: TierKey | null = row?.tier_key ?? planForPrice(priceId) ?? (isTierKey(md.plan) ? md.plan : null)
  const status = ev.type === 'customer.subscription.deleted' ? 'canceled' : mapStripeStatus(sub.status)
  // current_period_end moved from the subscription to its items in newer API versions; read either
  const periodEnd = ts(sub.current_period_end) ?? ts(items[0]?.current_period_end)
  const pastDueSince = status === 'past_due' ? (prior?.status === 'past_due' && prior.past_due_since ? prior.past_due_since : new Date(ev.created * 1000).toISOString()) : null
  const schedule = idOf(sub.schedule)
  const details = (sub.cancellation_details ?? {}) as { feedback?: unknown; comment?: unknown }
  const feedback = typeof details.feedback === 'string' && CANCEL_REASONS.includes(details.feedback as CancelReason) ? details.feedback : null
  const endedAt = status === 'canceled' ? (ts(sub.ended_at) ?? new Date(ev.created * 1000).toISOString()) : null
  await db.query(
    `insert into billing_subscriptions (org_id, provider, external_id, customer_external_id, status, plan, plan_key, price_external_id, item_external_id, current_period_end, cancel_at_period_end,
        trial_start, trial_end, past_due_since, livemode, last_event_at, schedule_external_id, canceled_at, ended_at, cancel_reason)
     values ($1,'stripe',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,to_timestamp($15),$16,$17,$18,$19)
     on conflict (org_id, provider) do update set external_id = excluded.external_id, customer_external_id = excluded.customer_external_id, status = excluded.status,
       plan = coalesce(excluded.plan, billing_subscriptions.plan), plan_key = coalesce(excluded.plan_key, billing_subscriptions.plan_key),
       price_external_id = coalesce(excluded.price_external_id, billing_subscriptions.price_external_id), item_external_id = coalesce(excluded.item_external_id, billing_subscriptions.item_external_id),
       current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
       trial_start = excluded.trial_start, trial_end = excluded.trial_end, past_due_since = excluded.past_due_since, livemode = excluded.livemode, last_event_at = excluded.last_event_at,
       schedule_external_id = excluded.schedule_external_id,
       pending_plan_key = case when excluded.schedule_external_id is null then null else billing_subscriptions.pending_plan_key end,
       pending_change_at = case when excluded.schedule_external_id is null then null else billing_subscriptions.pending_change_at end,
       canceled_at = coalesce(excluded.canceled_at, billing_subscriptions.canceled_at), ended_at = excluded.ended_at,
       cancel_reason = case when excluded.cancel_at_period_end or excluded.status = 'canceled' then coalesce(billing_subscriptions.cancel_reason, excluded.cancel_reason) else null end,
       cancel_comment = case when excluded.cancel_at_period_end or excluded.status = 'canceled' then billing_subscriptions.cancel_comment else null end,
       cancel_requested_at = case when excluded.cancel_at_period_end or excluded.status = 'canceled' then billing_subscriptions.cancel_requested_at else null end`,
    [orgId, subId, customer, status, plan, planKey, priceId && /^price_[A-Za-z0-9]+$/.test(priceId) ? priceId : null, str(items[0]?.id) && /^si_[A-Za-z0-9]+$/.test(items[0]!.id!) ? items[0]!.id : null,
      periodEnd, sub.cancel_at_period_end === true, ts(sub.trial_start), ts(sub.trial_end), pastDueSince, ev.livemode, ev.created,
      schedule && /^sub_sched_[A-Za-z0-9]+$/.test(schedule) ? schedule : null, ts(sub.canceled_at), endedAt, feedback])
  // the plan follows a paying subscription: upgrades and downgrades take effect when Stripe confirms them, never on the request
  let planChanged = false
  if (plan && (status === 'active' || status === 'trialing')) {
    const r = await db.query(`update agencies set plan_tier = $2, plan_key = coalesce($3, plan_key), plan_changed_at = now() where id = $1 and (plan_tier is distinct from $2 or ($3::text is not null and plan_key is distinct from $3)) returning id`, [orgId, plan, planKey])
    planChanged = r.length > 0 && Boolean(prior) && prior!.plan_key !== null && planKey !== null && prior!.plan_key !== planKey
    if (planKey) {
      const applied = await db.query<{ id: string }>(`update billing_plan_changes set status = 'applied', applied_at = now() where org_id = $1 and subscription_external_id = $2 and to_plan_key = $3 and status in ('requested','scheduled') returning id`, [orgId, subId, planKey])
      // a change that Stripe applied some other way (e.g. in the dashboard) supersedes requests for other plans
      if (applied.length || planChanged) await db.query(`update billing_plan_changes set status = 'cancelled' where org_id = $1 and status in ('previewed','requested') and to_plan_key <> $2`, [orgId, planKey])
    }
  }
  await trackTrial(db, orgId, { subId, customer, planKey, status, prior, trialStart: ts(sub.trial_start), trialEnd: ts(sub.trial_end), at: ev.created })
  const link = billingPageLink()
  if (planChanged && row) await queueNotice(db, { orgId, kind: 'plan_changed', dedupeKey: `plan_changed:${subId}:${planKey}:${ev.created}`, ...planChangedNotice({ planName: row.display_name, link }) })
  if (sub.cancel_at_period_end === true && !prior?.cancel_at_period_end && status !== 'canceled')
    await queueNotice(db, { orgId, kind: 'cancel_scheduled', dedupeKey: `cancel_scheduled:${subId}:${periodEnd ?? ''}`, ...cancelScheduledNotice({ periodEnd, link }) })
  if (status === 'canceled' && prior?.status !== 'canceled') await queueNotice(db, { orgId, kind: 'subscription_canceled', dedupeKey: `subscription_canceled:${subId}`, ...canceledNotice(link) })
  if (status === 'unpaid' && prior?.status !== 'unpaid') await queueNotice(db, { orgId, kind: 'read_only', dedupeKey: `read_only:${subId}:${ev.created}`, ...readOnlyNotice(portalLink()) })
  await audit(db, { orgId, entityType: 'subscription', entityId: subId, event: `subscription.${status}`, actor: 'stripe:webhook', detail: { provider: 'stripe', plan, plan_key: planKey, event: ev.type, cancel_at_period_end: sub.cancel_at_period_end === true } })
  return { outcome: 'processed', orgId, detail: `subscription ${status}` }
}

/** Trials: recorded once per organization when Stripe first reports one; its outcome follows the subscription. */
async function trackTrial(db: Db, orgId: string, s: { subId: string; customer: string | null; planKey: string | null; status: SubscriptionStatus; prior: PriorSub | null; trialStart: string | null; trialEnd: string | null; at: number }) {
  if (s.status === 'trialing') {
    const hash = (await db.one<{ email_hash: string | null }>('select email_hash from billing_customers where org_id = $1', [orgId]))?.email_hash ?? null
    // one per organization, customer and e-mail: a conflict on any of them records nothing new
    await db.query(`insert into billing_trials (org_id, plan_key, customer_external_id, subscription_external_id, email_hash, started_at, ends_at) values ($1,$2,$3,$4,$5,coalesce($6::timestamptz, to_timestamp($8)),$7) on conflict do nothing`,
      [orgId, s.planKey, s.customer, s.subId, hash, s.trialStart, s.trialEnd, s.at])
    await db.query(`update billing_trials set ends_at = $3 where org_id = $1 and subscription_external_id = $2 and outcome = 'trialing'`, [orgId, s.subId, s.trialEnd])
    return
  }
  if (s.prior?.status !== 'trialing') return
  const outcome = s.status === 'active' ? 'converted' : s.status === 'canceled' ? 'canceled' : 'lapsed'
  await db.query(`update billing_trials set outcome = $3, converted_at = case when $3 = 'converted' then to_timestamp($4) else converted_at end, ended_at = to_timestamp($4)
    where org_id = $1 and subscription_external_id = $2 and outcome = 'trialing'`, [orgId, s.subId, outcome, s.at])
}

/** Stripe's three-day warning before a trial ends: remind the owner (the hourly job sends the same reminder if this event is missed). */
async function onTrialWillEnd(db: Db, orgId: string, sub: Record<string, unknown>, ev: StripeEvent): Promise<Outcome> {
  const trialEnd = ts(sub.trial_end)
  if (!trialEnd || sub.status !== 'trialing') return { outcome: 'ignored', orgId, detail: 'not trialing' }
  const queued = await queueTrialReminder(db, orgId, { subId: str(sub.id)!, trialEnd, planKey: (await db.one<{ plan_key: string | null }>(`select plan_key from billing_subscriptions where org_id = $1 and provider = 'stripe'`, [orgId]))?.plan_key ?? null, now: new Date(ev.created * 1000) })
  return { outcome: 'processed', orgId, detail: queued ? 'trial ending: owner reminded' : 'trial ending: already reminded' }
}

/** Queue the trial-ending reminder once per subscription and trial end. */
export async function queueTrialReminder(db: Db, orgId: string, i: { subId: string; trialEnd: string; planKey: string | null; now: Date }) {
  const plan = i.planKey ? await db.one<{ display_name: string }>('select display_name from plans where key = $1', [i.planKey]) : null
  const daysLeft = Math.max(0, Math.ceil((new Date(i.trialEnd).getTime() - i.now.getTime()) / 86400e3))
  return queueNotice(db, { orgId, kind: 'trial_ending', dedupeKey: `trial_ending:${i.subId}:${i.trialEnd.slice(0, 10)}`, ...trialEndingNotice({ planName: plan?.display_name ?? 'Deploi', trialEnd: i.trialEnd, daysLeft, link: portalLink() }) })
}

async function onInvoice(db: Db, ev: StripeEvent): Promise<Outcome> {
  const inv = ev.data.object
  const customer = idOf(inv.customer)
  const orgId = await orgForCustomer(db, customer)
  if (!orgId) return { outcome: 'ignored', orgId: null, detail: 'invoice for an unknown customer' }
  await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 4213))`, [`billing-sub:${orgId}`])
  // the subscription id sits at the top level in older API versions and under parent.subscription_details in newer ones
  const parent = (inv.parent ?? {}) as { subscription_details?: { subscription?: unknown } }
  const subId = idOf(inv.subscription) ?? idOf(parent.subscription_details?.subscription)
  const row = await db.one<{ external_id: string | null; status: SubscriptionStatus; last_invoice_event_at: string | null; past_due_since: string | null }>(
    `select external_id, status, last_invoice_event_at::text, past_due_since::text from billing_subscriptions where org_id = $1 and provider = 'stripe'`, [orgId])
  if (!row || (subId && row.external_id && row.external_id !== subId)) return { outcome: 'ignored', orgId, detail: 'invoice for a subscription that is not the current one' }
  // ordering: a failure delivered after the newer payment (or the other way round) changes nothing
  if (row.last_invoice_event_at && new Date(row.last_invoice_event_at).getTime() > ev.created * 1000) return { outcome: 'ignored', orgId, detail: 'older than the last applied invoice event' }
  await db.query(`update billing_subscriptions set last_invoice_event_at = to_timestamp($2) where org_id = $1 and provider = 'stripe'`, [orgId, ev.created])
  const invoiceId = str(inv.id)
  if (ev.type === 'invoice.payment_failed') {
    // start the grace period now if the subscription event has not already
    await db.query(`update billing_subscriptions set status = case when status in ('active','trialing') then 'past_due' else status end,
       past_due_since = coalesce(past_due_since, to_timestamp($2)) where org_id = $1 and provider = 'stripe' and status in ('active','trialing','past_due')`, [orgId, ev.created])
    const attempt = typeof inv.attempt_count === 'number' ? inv.attempt_count : 1
    const amount = typeof inv.amount_due === 'number' ? inv.amount_due : null
    const currency = typeof inv.currency === 'string' && /^[a-z]{3}$/.test(inv.currency) ? inv.currency : null
    const hosted = typeof inv.hosted_invoice_url === 'string' && /^https:\/\//.test(inv.hosted_invoice_url) ? inv.hosted_invoice_url : null
    const nextAttempt = ts(inv.next_payment_attempt)
    if (invoiceId && /^in_[A-Za-z0-9_]+$/.test(invoiceId)) await db.query(
      `insert into billing_payment_failures (org_id, subscription_external_id, invoice_external_id, attempt_count, amount_due_cents, currency, hosted_invoice_url, next_attempt_at, failed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9)) on conflict (invoice_external_id, attempt_count) do nothing`, [orgId, subId, invoiceId, attempt, amount, currency, hosted, nextAttempt, ev.created])
    await db.query(`update billing_trials set outcome = 'lapsed', ended_at = to_timestamp($2) where org_id = $1 and outcome = 'trialing' and ends_at <= to_timestamp($2) + interval '1 hour'`, [orgId, ev.created])
    const since = (await db.one<{ past_due_since: string | null }>(`select past_due_since::text from billing_subscriptions where org_id = $1 and provider = 'stripe'`, [orgId]))?.past_due_since
    const graceEndsAt = since ? new Date(new Date(since).getTime() + stripeConfig.graceDays * 86400e3).toISOString() : null
    await queueNotice(db, { orgId, kind: 'payment_failed', dedupeKey: `payment_failed:${invoiceId ?? ev.id}:${attempt}`, ...paymentFailedNotice({ amountDueCents: amount, currency, attempt, nextAttemptAt: nextAttempt, graceEndsAt, link: portalLink(), hostedInvoiceUrl: hosted }) })
    await audit(db, { orgId, entityType: 'subscription', entityId: subId, event: 'billing.payment_failed', actor: 'stripe:webhook', detail: { attempt_count: attempt, invoice: invoiceId, next_payment_attempt: nextAttempt } })
    return { outcome: 'processed', orgId, detail: 'payment failed: grace period started; owner notified' }
  }
  // invoice.paid: a past_due subscription recovers
  await db.query(`update billing_subscriptions set status = case when status in ('past_due','unpaid') then 'active' else status end, past_due_since = null where org_id = $1 and provider = 'stripe'`, [orgId])
  const recovered = await db.query<{ id: string }>(`update billing_payment_failures set recovered_at = to_timestamp($2) where org_id = $1 and recovered_at is null returning id`, [orgId, ev.created])
  if (typeof inv.amount_paid === 'number' && inv.amount_paid > 0)
    await db.query(`update billing_trials set outcome = 'converted', converted_at = to_timestamp($2), ended_at = coalesce(ended_at, to_timestamp($2)) where org_id = $1 and outcome in ('trialing','lapsed') and (ends_at is null or ends_at <= to_timestamp($2) + interval '1 hour')`, [orgId, ev.created])
  if (recovered.length) await queueNotice(db, { orgId, kind: 'payment_recovered', dedupeKey: `payment_recovered:${invoiceId ?? ev.id}`, ...paymentRecoveredNotice(billingPageLink()) })
  await audit(db, { orgId, entityType: 'subscription', entityId: subId, event: 'billing.invoice_paid', actor: 'stripe:webhook', detail: { invoice: invoiceId, recovered_failures: recovered.length } })
  return { outcome: 'processed', orgId, detail: recovered.length ? 'invoice paid: recovered' : 'invoice paid' }
}

export async function handleStripeEvent(db: Db, ev: StripeEvent): Promise<{ duplicate: boolean } & Partial<Outcome>> {
  const claimed = await db.one<{ id: string }>(`insert into billing_events (id, type, livemode) values ($1,$2,$3) on conflict (id) do nothing returning id`, [ev.id, ev.type.slice(0, 100), ev.livemode])
  if (!claimed) return { duplicate: true }
  let r: Outcome
  switch (ev.type) {
    case 'checkout.session.completed': r = await onCheckoutCompleted(db, ev); break
    case 'customer.subscription.created': case 'customer.subscription.updated': case 'customer.subscription.deleted':
    case 'customer.subscription.paused': case 'customer.subscription.resumed': case 'customer.subscription.trial_will_end': r = await onSubscription(db, ev); break
    case 'invoice.payment_failed': case 'invoice.paid': r = await onInvoice(db, ev); break
    default: r = { outcome: 'ignored', orgId: null, detail: 'event type not handled' }
  }
  // a lower plan or a lapse takes effect at once and safely: the organization is brought within its limits in
  // this same transaction (lib/plans/enforce.ts; idempotent, nothing deleted, an upgrade resumes nothing)
  if (r.outcome === 'processed' && r.orgId) {
    const { enforcePlanLimits } = await import('../plans/enforce')
    const enforced = await enforcePlanLimits(db, r.orgId, { actor: 'stripe:webhook', cause: ev.type })
    if (enforced?.changed) r = { ...r, detail: `${r.detail}; plan limits applied` }
  }
  await db.query(`update billing_events set outcome = $2, org_id = $3, detail = $4, processed_at = now() where id = $1`, [ev.id, r.outcome, r.orgId, r.detail.slice(0, 300)])
  return { duplicate: false, ...r }
}
