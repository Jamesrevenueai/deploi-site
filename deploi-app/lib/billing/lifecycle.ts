/**
 * Changing a Stripe subscription from the billing page: plan changes with a preview, cancellation at period
 * end with a reason, reactivation, and the Stripe-side account facts the page shows (invoices, payment method).
 *
 * Plan changes follow Stripe's documented approach:
 *   preview    POST /v1/invoices/create_preview with subscription_details (items, proration_behavior,
 *              proration_date): Stripe's own numbers, shown before the owner confirms
 *   upgrade    POST /v1/subscriptions/:id with the item's new price, proration_behavior=create_prorations and
 *              the preview's proration_date (the prorated difference is added to the next invoice)
 *   downgrade  at period end through a subscription schedule: POST /v1/subscription_schedules
 *              (from_subscription), then POST /v1/subscription_schedules/:id with two phases (the current price
 *              until the period ends, then the new price) and end_behavior=release
 * Entitlements switch only when Stripe confirms (customer.subscription.updated, lib/billing/webhooks.ts),
 * never on the request; the downgrade enforcement (lib/plans/enforce.ts) runs on that webhook.
 *
 * Cancellation: cancel_at_period_end=true with cancellation_details (Stripe's feedback values and a comment);
 * the account keeps full service until the period ends, then is read-only (data kept; deletion is separate).
 * Reactivation before the end sets cancel_at_period_end=false.
 */
import type { Db } from '../db'
import { HttpError } from '../store/request'
import { audit } from '../engine/audit'
import { checkoutRefusal, planByKey, type PlanRow } from '../plans/catalog'
import { billingMode, stripeConfig } from './config'
import { stripeRequest } from './stripe'
import { viaStripe } from './checkout'
import { billingProviderFor } from './state'
import { planOfSubscription, priceIdForPlan } from './plans'
import { CANCEL_REASONS, queueTrialReminder, type CancelReason } from './webhooks'

type FetchOpt = { fetchImpl?: typeof fetch }

type StripeSub = {
  id: string; status: string; customer: string; cancel_at_period_end: boolean; schedule: string | { id: string } | null
  items: { data: { id: string; price: { id: string }; current_period_start?: number; current_period_end?: number }[] }
  current_period_end?: number
}
type StripeInvoice = {
  id?: string; amount_due: number; total?: number; subtotal?: number; currency: string; period_end?: number; next_payment_attempt?: number | null
  lines?: { data?: { description?: string | null; amount: number; proration?: boolean; parent?: { subscription_item_details?: { proration?: boolean } } | null }[] }
}

export type ChangePreview = {
  changeId: string; direction: 'upgrade' | 'downgrade'; from: { key: string; name: string; priceCents: number } | null; to: { key: string; name: string; priceCents: number; pilot: boolean }
  amountDueCents: number; currency: string; prorationCents: number; effectiveAt: string | null; lines: { description: string; amountCents: number; proration: boolean }[]
  /** what happens, in words */ summary: string
}

const CHANGE_TTL_MS = 30 * 60e3

function assertOn() {
  if (billingMode() === 'off') throw new HttpError(409, 'billing_off', 'billing is not switched on yet: the private beta is free')
  if (!stripeConfig.configured) throw new HttpError(503, 'billing_not_configured', 'billing is not configured in this environment')
}

type LocalSub = { external_id: string | null; customer_external_id: string | null; status: string; plan: string | null; plan_key: string | null; schedule_external_id: string | null; cancel_at_period_end: boolean; current_period_end: string | null }

async function currentSub(db: Db, orgId: string): Promise<LocalSub & { external_id: string }> {
  if ((await billingProviderFor(db, orgId)) !== 'stripe') throw new HttpError(409, 'use_shopify_billing', 'this store is billed through Shopify: change the plan in the Shopify admin')
  const s = await db.one<LocalSub>(`select external_id, customer_external_id, status, plan, plan_key, schedule_external_id, cancel_at_period_end, current_period_end::text from billing_subscriptions where org_id = $1 and provider = 'stripe' for update`, [orgId])
  if (!s?.external_id || !/^sub_[A-Za-z0-9]+$/.test(s.external_id)) throw new HttpError(409, 'no_subscription', 'there is no subscription to change: choose a plan first')
  return s as LocalSub & { external_id: string }
}

const fetchSub = (id: string, o: FetchOpt) => stripeRequest<StripeSub>('GET', `/v1/subscriptions/${id}`, {}, { fetchImpl: o.fetchImpl })
const scheduleId = (s: StripeSub) => (typeof s.schedule === 'string' ? s.schedule : s.schedule?.id ?? null)

function summarizePreview(inv: StripeInvoice) {
  const lines = (inv.lines?.data ?? []).map(l => ({ description: (l.description ?? '').slice(0, 200), amountCents: l.amount, proration: Boolean(l.proration ?? l.parent?.subscription_item_details?.proration) }))
  return { amountDueCents: inv.amount_due, currency: inv.currency, prorationCents: lines.filter(l => l.proration).reduce((s, l) => s + l.amountCents, 0), lines }
}

/** Stripe's preview of moving to `planKey`, recorded so the confirmation uses the same proration date. */
export async function previewPlanChange(db: Db, input: { orgId: string; planKey: unknown; actor: string; now?: Date } & FetchOpt): Promise<ChangePreview> {
  assertOn()
  const now = input.now ?? new Date()
  if (typeof input.planKey !== 'string') throw new HttpError(400, 'invalid_input', 'plan is required')
  const target = await planByKey(input.planKey, db)
  if (!target) throw new HttpError(400, 'invalid_input', 'plan must be one of the plans on sale')
  const refused = checkoutRefusal(target, billingMode())
  if (refused) throw new HttpError(409, 'plan_not_approved', refused)
  const price = priceIdForPlan(target)
  if (!price) throw new HttpError(503, 'billing_not_configured', `no Stripe price is configured for the ${target.key} plan`)
  const local = await currentSub(db, input.orgId)
  if (!['active', 'trialing'].includes(local.status)) throw new HttpError(409, 'subscription_not_active', local.status === 'past_due' || local.status === 'unpaid'
    ? 'a payment is outstanding: update the payment method first, then change plan' : 'there is no active subscription to change: choose a plan first')
  const fromRow = await planOfSubscription(db, local)
  if (fromRow?.key === target.key) throw new HttpError(409, 'same_plan', `you are already on the ${target.display_name} plan`)
  return viaStripe(async () => {
    const sub = await fetchSub(local.external_id, input)
    const item = sub.items?.data?.[0]
    if (!item?.id) throw new HttpError(502, 'stripe_error', 'the subscription has no item to change')
    const direction: 'upgrade' | 'downgrade' = fromRow && target.monthly_price_cents < fromRow.monthly_price_cents ? 'downgrade' : 'upgrade'
    const prorationDate = Math.floor(now.getTime() / 1000)
    const periodEnd = item.current_period_end ?? sub.current_period_end ?? null
    const inv = await stripeRequest<StripeInvoice>('POST', '/v1/invoices/create_preview', {
      customer: sub.customer, subscription: sub.id,
      subscription_details: direction === 'upgrade'
        ? { items: [{ id: item.id, price }], proration_behavior: 'create_prorations', proration_date: prorationDate }
        : { items: [{ id: item.id, price }], proration_behavior: 'none' },
    }, { idempotencyKey: `deploi-preview-${input.orgId}-${target.key}-${prorationDate}`, fetchImpl: input.fetchImpl })
    const p = summarizePreview(inv)
    const effectiveAt = direction === 'downgrade' && periodEnd ? new Date(periodEnd * 1000).toISOString() : null
    const row = await db.one<{ id: string }>(
      `insert into billing_plan_changes (org_id, subscription_external_id, from_plan_key, to_plan_key, direction, status, proration_date, preview, effective_at, requested_by)
       values ($1,$2,$3,$4,$5,'previewed',to_timestamp($6),$7,$8,$9) returning id`,
      [input.orgId, sub.id, fromRow?.key ?? null, target.key, direction, prorationDate, JSON.stringify(p), effectiveAt, input.actor.slice(0, 160)])
    const money = (c: number) => `${(c / 100).toFixed(2)} ${p.currency.toUpperCase()}`
    const summary = direction === 'upgrade'
      ? `The ${target.display_name} plan starts as soon as Stripe confirms. The prorated difference (${money(p.prorationCents)}) is added to your next invoice of ${money(p.amountDueCents)}.`
      : `You keep the ${fromRow?.display_name ?? 'current'} plan until ${effectiveAt?.slice(0, 10) ?? 'the end of the period'}; then the ${target.display_name} plan applies and the next invoice is ${money(p.amountDueCents)}. No refund or credit is issued for the current period.`
    return {
      changeId: row!.id, direction, from: fromRow ? { key: fromRow.key, name: fromRow.display_name, priceCents: fromRow.monthly_price_cents } : null,
      to: { key: target.key, name: target.display_name, priceCents: target.monthly_price_cents, pilot: target.status === 'hypothesis' },
      ...p, effectiveAt, summary,
    }
  })
}

/** Confirm a previewed change: upgrade now with prorations, or schedule the downgrade at period end. */
export async function confirmPlanChange(db: Db, input: { orgId: string; changeId: unknown; actor: string; now?: Date } & FetchOpt) {
  assertOn()
  const now = input.now ?? new Date()
  if (typeof input.changeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.changeId)) throw new HttpError(400, 'invalid_input', 'changeId is required')
  const ch = await db.one<{ id: string; subscription_external_id: string; to_plan_key: string; direction: 'upgrade' | 'downgrade'; status: string; proration_date: string; created_at: string }>(
    `select id, subscription_external_id, to_plan_key, direction, status, proration_date::text, created_at::text from billing_plan_changes where id = $1 and org_id = $2 for update`, [input.changeId, input.orgId])
  if (!ch) throw new HttpError(404, 'not_found', 'no such plan change')
  if (ch.status !== 'previewed') throw new HttpError(409, 'already_confirmed', `this change is already ${ch.status}`)
  if (now.getTime() - new Date(ch.created_at).getTime() > CHANGE_TTL_MS) {
    await db.query(`update billing_plan_changes set status = 'expired' where id = $1`, [ch.id])
    throw new HttpError(409, 'preview_expired', 'the preview is more than 30 minutes old: preview the change again')
  }
  const local = await currentSub(db, input.orgId)
  if (local.external_id !== ch.subscription_external_id || !['active', 'trialing'].includes(local.status)) throw new HttpError(409, 'subscription_changed', 'the subscription changed since the preview: preview again')
  const target = (await planByKey(ch.to_plan_key, db)) as PlanRow
  const refused = checkoutRefusal(target, billingMode())
  if (refused) throw new HttpError(409, 'plan_not_approved', refused)
  const price = priceIdForPlan(target)!
  const fromRow = await planOfSubscription(db, local)
  return viaStripe(async () => {
    const sub = await fetchSub(local.external_id, input)
    const item = sub.items.data[0]
    // an earlier pending downgrade is replaced: release its schedule first (the subscription keeps its current price)
    const existing = scheduleId(sub)
    if (existing) await stripeRequest('POST', `/v1/subscription_schedules/${existing}/release`, {}, { idempotencyKey: `deploi-release-${existing}-${ch.id}`, fetchImpl: input.fetchImpl })
    if (existing) await db.query(`update billing_plan_changes set status = 'cancelled' where org_id = $1 and status = 'scheduled' and id <> $2`, [input.orgId, ch.id])
    const meta = { org_id: input.orgId, plan: target.tier_key, plan_key: target.key }
    if (ch.direction === 'upgrade') {
      await stripeRequest('POST', `/v1/subscriptions/${sub.id}`, {
        items: [{ id: item.id, price }], proration_behavior: 'create_prorations', proration_date: Math.floor(new Date(ch.proration_date).getTime() / 1000), metadata: meta,
      }, { idempotencyKey: `deploi-change-${ch.id}`, fetchImpl: input.fetchImpl })
      await db.query(`update billing_plan_changes set status = 'requested' where id = $1`, [ch.id])
      await db.query(`update billing_subscriptions set pending_plan_key = null, pending_change_at = null, schedule_external_id = null where org_id = $1 and provider = 'stripe'`, [input.orgId])
    } else {
      const sched = await stripeRequest<{ id: string; phases: { start_date: number; end_date: number; items: { price: string | { id: string }; quantity?: number }[] }[] }>(
        'POST', '/v1/subscription_schedules', { from_subscription: sub.id }, { idempotencyKey: `deploi-schedule-${ch.id}`, fetchImpl: input.fetchImpl })
      const phase = sched.phases[0]
      const currentPrice = typeof phase.items[0].price === 'string' ? phase.items[0].price : phase.items[0].price.id
      await stripeRequest('POST', `/v1/subscription_schedules/${sched.id}`, {
        end_behavior: 'release',
        phases: [
          { items: [{ price: currentPrice, quantity: phase.items[0].quantity ?? 1 }], start_date: phase.start_date, end_date: phase.end_date },
          { items: [{ price, quantity: 1 }], proration_behavior: 'none', duration: { interval: 'month', interval_count: 1 }, metadata: meta },
        ],
      }, { idempotencyKey: `deploi-schedule-phases-${ch.id}`, fetchImpl: input.fetchImpl })
      const at = new Date(phase.end_date * 1000).toISOString()
      await db.query(`update billing_plan_changes set status = 'scheduled', schedule_external_id = $2, effective_at = $3 where id = $1`, [ch.id, sched.id, at])
      await db.query(`update billing_subscriptions set schedule_external_id = $2, pending_plan_key = $3, pending_change_at = $4 where org_id = $1 and provider = 'stripe'`, [input.orgId, sched.id, target.key, at])
    }
    await audit(db, { orgId: input.orgId, entityType: 'subscription', entityId: sub.id, event: ch.direction === 'upgrade' ? 'billing.upgrade_requested' : 'billing.downgrade_scheduled', actor: input.actor,
      detail: { from: fromRow?.key ?? null, to: target.key, plan_status: target.status, change: ch.id } })
    return { changeId: ch.id, direction: ch.direction, status: ch.direction === 'upgrade' ? 'requested' : 'scheduled',
      message: ch.direction === 'upgrade' ? `Requested: the ${target.display_name} plan applies as soon as Stripe confirms (usually a few seconds).` : `Scheduled: the ${target.display_name} plan starts at the end of the current period.` }
  })
}

/** Drop a scheduled downgrade (the schedule is released; the subscription keeps its current plan). */
export async function cancelPendingChange(db: Db, input: { orgId: string; actor: string } & FetchOpt) {
  assertOn()
  const local = await currentSub(db, input.orgId)
  if (!local.schedule_external_id) throw new HttpError(409, 'nothing_pending', 'there is no scheduled plan change')
  await viaStripe(() => stripeRequest('POST', `/v1/subscription_schedules/${local.schedule_external_id}/release`, {}, { idempotencyKey: `deploi-release-${local.schedule_external_id}`, fetchImpl: input.fetchImpl }))
  await db.query(`update billing_plan_changes set status = 'cancelled' where org_id = $1 and status = 'scheduled'`, [input.orgId])
  await db.query(`update billing_subscriptions set schedule_external_id = null, pending_plan_key = null, pending_change_at = null where org_id = $1 and provider = 'stripe'`, [input.orgId])
  await audit(db, { orgId: input.orgId, entityType: 'subscription', entityId: local.external_id, event: 'billing.downgrade_cancelled', actor: input.actor })
  return { done: true }
}

/** Cancel at the end of the period, with Stripe's feedback value and an optional comment. */
export async function cancelSubscription(db: Db, input: { orgId: string; reason: unknown; comment?: unknown; actor: string } & FetchOpt) {
  assertOn()
  if (typeof input.reason !== 'string' || !CANCEL_REASONS.includes(input.reason as CancelReason)) throw new HttpError(400, 'invalid_input', `reason must be one of ${CANCEL_REASONS.join(', ')}`)
  const comment = typeof input.comment === 'string' ? input.comment.trim().slice(0, 500) : ''
  const local = await currentSub(db, input.orgId)
  if (!['active', 'trialing', 'past_due'].includes(local.status)) throw new HttpError(409, 'not_cancellable', 'the subscription is not active')
  if (local.cancel_at_period_end) throw new HttpError(409, 'already_cancelling', 'the subscription is already set to end')
  const res = await viaStripe(async () => {
    // a subscription run by a schedule (a pending downgrade) is released first: cancelling replaces the downgrade
    if (local.schedule_external_id) await stripeRequest('POST', `/v1/subscription_schedules/${local.schedule_external_id}/release`, {}, { idempotencyKey: `deploi-release-${local.schedule_external_id}-cancel`, fetchImpl: input.fetchImpl })
    return stripeRequest<StripeSub>('POST', `/v1/subscriptions/${local.external_id}`, {
      cancel_at_period_end: true, cancellation_details: { feedback: input.reason, comment: comment || undefined },
    }, { idempotencyKey: `deploi-cancel-at-end-${local.external_id}-${Date.now() - (Date.now() % 60e3)}`, fetchImpl: input.fetchImpl })
  })
  if (local.schedule_external_id) await db.query(`update billing_plan_changes set status = 'cancelled' where org_id = $1 and status = 'scheduled'`, [input.orgId])
  // Stripe's response is its confirmation of the flag; the reason is ours
  await db.query(`update billing_subscriptions set cancel_at_period_end = $2, cancel_reason = $3, cancel_comment = $4, cancel_requested_at = now(), schedule_external_id = null, pending_plan_key = null, pending_change_at = null
    where org_id = $1 and provider = 'stripe'`, [input.orgId, res.cancel_at_period_end === true, input.reason, comment || null])
  await audit(db, { orgId: input.orgId, entityType: 'subscription', entityId: local.external_id, event: 'billing.cancel_requested', actor: input.actor, detail: { reason: input.reason, at_period_end: true } })
  return { cancelled: true, endsAt: local.current_period_end }
}

/** Undo a cancellation before the period ends. */
export async function reactivateSubscription(db: Db, input: { orgId: string; actor: string; now?: Date } & FetchOpt) {
  assertOn()
  const local = await currentSub(db, input.orgId)
  if (local.status === 'canceled') throw new HttpError(409, 'already_ended', 'the subscription has ended: choose a plan to start a new one')
  if (!local.cancel_at_period_end) throw new HttpError(409, 'not_cancelling', 'the subscription is not set to end')
  if (local.current_period_end && new Date(local.current_period_end) <= (input.now ?? new Date())) throw new HttpError(409, 'already_ended', 'the period has ended')
  const res = await viaStripe(() => stripeRequest<StripeSub>('POST', `/v1/subscriptions/${local.external_id}`, { cancel_at_period_end: false },
    { idempotencyKey: `deploi-reactivate-${local.external_id}-${Date.now() - (Date.now() % 60e3)}`, fetchImpl: input.fetchImpl }))
  await db.query(`update billing_subscriptions set cancel_at_period_end = $2, cancel_reason = null, cancel_comment = null, cancel_requested_at = null where org_id = $1 and provider = 'stripe'`, [input.orgId, res.cancel_at_period_end === true])
  await audit(db, { orgId: input.orgId, entityType: 'subscription', entityId: local.external_id, event: 'billing.reactivated', actor: input.actor })
  return { done: true }
}

export type InvoiceSummary = { id: string; number: string | null; status: string; amountDueCents: number; amountPaidCents: number; currency: string; created: string; hostedUrl: string | null; pdfUrl: string | null }
export type PaymentMethodSummary = { brand: string; last4: string; expMonth: number | null; expYear: number | null } | null

type StripePm = { type?: string; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } } | string | null | undefined
function pmSummary(pm: StripePm): PaymentMethodSummary {
  if (!pm || typeof pm === 'string' || !pm.card?.last4) return null
  return { brand: pm.card.brand ?? 'card', last4: pm.card.last4, expMonth: pm.card.exp_month ?? null, expYear: pm.card.exp_year ?? null }
}
const httpsOrNull = (u: unknown) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null)

/** The invoices and payment method Stripe holds for the organization (read-only; nothing is stored). */
export async function stripeAccount(db: Db, orgId: string, opts: FetchOpt = {}): Promise<{ invoices: InvoiceSummary[]; paymentMethod: PaymentMethodSummary }> {
  assertOn()
  const c = await db.one<{ external_id: string }>('select external_id from billing_customers where org_id = $1', [orgId])
  if (!c) return { invoices: [], paymentMethod: null }
  const sub = await db.one<{ external_id: string | null }>(`select external_id from billing_subscriptions where org_id = $1 and provider = 'stripe'`, [orgId])
  return viaStripe(async () => {
    const list = await stripeRequest<{ data: Record<string, unknown>[] }>('GET', '/v1/invoices', { customer: c.external_id, limit: 12 }, { fetchImpl: opts.fetchImpl })
    const invoices = (list.data ?? []).filter(i => i.status !== 'draft').map(i => ({
      id: String(i.id), number: typeof i.number === 'string' ? i.number : null, status: String(i.status ?? 'open'),
      amountDueCents: Number(i.amount_due ?? 0), amountPaidCents: Number(i.amount_paid ?? 0), currency: String(i.currency ?? 'usd'),
      created: new Date(Number(i.created ?? 0) * 1000).toISOString(), hostedUrl: httpsOrNull(i.hosted_invoice_url), pdfUrl: httpsOrNull(i.invoice_pdf),
    }))
    const cust = await stripeRequest<{ invoice_settings?: { default_payment_method?: StripePm } }>('GET', `/v1/customers/${c.external_id}`, { expand: ['invoice_settings.default_payment_method'] }, { fetchImpl: opts.fetchImpl })
    let paymentMethod = pmSummary(cust.invoice_settings?.default_payment_method)
    if (!paymentMethod && sub?.external_id && /^sub_[A-Za-z0-9]+$/.test(sub.external_id)) {
      const s = await stripeRequest<{ default_payment_method?: StripePm }>('GET', `/v1/subscriptions/${sub.external_id}`, { expand: ['default_payment_method'] }, { fetchImpl: opts.fetchImpl })
      paymentMethod = pmSummary(s.default_payment_method)
    }
    return { invoices, paymentMethod }
  })
}

/** Hourly: remind owners whose trial ends within three days (once per trial end; Stripe's trial_will_end event queues the same reminder). */
export async function queueTrialReminders(db: Db, now = new Date()): Promise<number> {
  if (billingMode() === 'off') return 0
  const due = await db.query<{ org_id: string; external_id: string; trial_end: string; plan_key: string | null }>(
    `select org_id, external_id, trial_end::text, plan_key from billing_subscriptions where provider = 'stripe' and status = 'trialing' and external_id is not null
       and trial_end > $1 and trial_end <= $1::timestamptz + interval '3 days' order by trial_end limit 500`, [now.toISOString()])
  let n = 0
  for (const s of due) if (await queueTrialReminder(db, s.org_id, { subId: s.external_id, trialEnd: new Date(s.trial_end).toISOString(), planKey: s.plan_key, now })) n++
  return n
}
