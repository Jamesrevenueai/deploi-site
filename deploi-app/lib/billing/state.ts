/**
 * Who bills an organization, and whether its subscription allows agents to write and send.
 *
 * Provider routing: an organization whose only active commerce connections are Shopify stores is a
 * Shopify App Store merchant and must be billed by Shopify (Shopify's rule for App Store apps). Every
 * other organization (a WooCommerce store, Deploi Office, or nothing connected yet) is billed by Stripe.
 *
 * Read-only: with BILLING_MODE on, a Stripe-billed organization keeps full service while its subscription
 * is trialing or active, and for BILLING_GRACE_DAYS after it becomes past_due. After that, or when it is
 * unpaid, canceled, incomplete or paused, or when there is no subscription, it is read-only: agents pause
 * writes and sends; every page and all data stay visible. Shopify-billed organizations are governed by
 * BILLING_REQUIRED and Shopify's own subscription (lib/engine/execute.ts), not by this file.
 */
import type { Db } from '../db'
import type { TierKey } from '../library/config'
import { billingMode, stripeConfig, type BillingMode } from './config'

export type BillingProvider = 'stripe' | 'shopify'
export type SubscriptionStatus = 'incomplete' | 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled' | 'paused'

export type SubscriptionRow = {
  provider: BillingProvider; status: SubscriptionStatus; plan: TierKey | null; external_id: string | null
  current_period_end: string | null; cancel_at_period_end: boolean; trial_end: string | null; past_due_since: string | null; livemode: boolean
}

export async function billingProviderFor(db: Db, orgId: string): Promise<BillingProvider> {
  const rows = await db.query<{ platform: string }>(`select distinct platform from store_connections where org_id = $1 and status = 'active'`, [orgId])
  return rows.length > 0 && rows.every(r => r.platform === 'shopify') ? 'shopify' : 'stripe'
}

export async function subscriptionOf(db: Db, orgId: string, provider: BillingProvider = 'stripe'): Promise<SubscriptionRow | null> {
  return db.one<SubscriptionRow>(
    `select provider, status, plan, external_id, current_period_end::text, cancel_at_period_end, trial_end::text, past_due_since::text, livemode
     from billing_subscriptions where org_id = $1 and provider = $2`, [orgId, provider])
}

export type BillingState = {
  mode: BillingMode
  provider: BillingProvider
  status: SubscriptionStatus | 'none' | 'not_required'
  plan: TierKey | null
  readOnly: boolean
  /** why it is read-only, or the warning while in the grace period */
  reason: string | null
  graceEndsAt: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
}

/** Pure: the state for a Stripe subscription row (or none) at `now`. */
export function stateFromSubscription(sub: SubscriptionRow | null, opts: { mode: BillingMode; graceDays: number; now?: Date }): BillingState {
  const now = opts.now ?? new Date()
  const base = { mode: opts.mode, provider: 'stripe' as const, plan: sub?.plan ?? null, graceEndsAt: null as string | null, currentPeriodEnd: sub?.current_period_end ?? null, cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end) }
  if (opts.mode === 'off') return { ...base, status: 'not_required', readOnly: false, reason: null }
  if (!sub) return { ...base, status: 'none', readOnly: true, reason: 'no subscription: choose a plan to let agents make changes and send email' }
  switch (sub.status) {
    case 'active': case 'trialing': return { ...base, status: sub.status, readOnly: false, reason: null }
    case 'past_due': {
      const since = sub.past_due_since ? new Date(sub.past_due_since) : now
      const ends = new Date(since.getTime() + opts.graceDays * 86400e3)
      const inGrace = now < ends
      return { ...base, status: 'past_due', graceEndsAt: ends.toISOString(), readOnly: !inGrace,
        reason: inGrace ? `payment failed: update the payment method before ${ends.toISOString().slice(0, 10)} to keep agents running` : 'payment failed and the grace period has ended: agents are paused until payment succeeds' }
    }
    case 'unpaid': return { ...base, status: 'unpaid', readOnly: true, reason: 'the subscription is unpaid: agents are paused until payment succeeds' }
    case 'canceled': return { ...base, status: 'canceled', readOnly: true, reason: 'the subscription was cancelled: the account is read-only' }
    case 'paused': return { ...base, status: 'paused', readOnly: true, reason: 'the subscription is paused: the account is read-only' }
    default: return { ...base, status: 'incomplete', readOnly: true, reason: 'the subscription has not started: complete checkout to let agents make changes' }
  }
}

/** The organization's billing state now. Shopify-billed organizations are never read-only here. */
export async function billingState(db: Db, orgId: string, now = new Date()): Promise<BillingState> {
  const mode = billingMode()
  const provider = mode === 'off' ? 'stripe' : await billingProviderFor(db, orgId)
  if (provider === 'shopify') {
    const sub = await subscriptionOf(db, orgId, 'shopify')
    return { mode, provider, status: 'not_required', plan: sub?.plan ?? null, readOnly: false, reason: null, graceEndsAt: null, currentPeriodEnd: sub?.current_period_end ?? null, cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end) }
  }
  const sub = mode === 'off' ? null : await subscriptionOf(db, orgId, 'stripe')
  return stateFromSubscription(sub, { mode, graceDays: stripeConfig.graceDays, now })
}

/** Why agents of this organization may not write to a store right now (null: they may). No query while billing is off. */
export async function billingWriteBlock(db: Db, orgId: string): Promise<string | null> {
  if (billingMode() === 'off') return null
  const s = await billingState(db, orgId)
  return s.readOnly ? `read-only: ${s.reason}` : null
}
