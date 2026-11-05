/**
 * Plans (the `plans` table, lib/plans/catalog.ts) and Stripe prices.
 *
 * A plan's Stripe price is its own stripe_price_id; the STRIPE_PRICE_<TIER>_MONTHLY environment fallback
 * applies only to the three tier plans (starter, growth, pro), never to a suite plan that happens to use a
 * tier's agents. A Stripe price maps back to the plan whose stripe_price_id it is, or to a tier plan through
 * that fallback. Prices shown to customers come from the plans table and stay labelled as pilot pricing while
 * the plan is a hypothesis; a hypothesis is never sold in live mode (checkoutRefusal).
 */
import type { Db } from '../db'
import { isTierKey } from '../library/config'
import { loadPlans, type PlanRow } from '../plans/catalog'
import { planForPrice, priceIdFor } from './config'

export function priceIdForPlan(row: Pick<PlanRow, 'key' | 'tier_key' | 'stripe_price_id'>): string | null {
  if (row.stripe_price_id) return row.stripe_price_id
  return isTierKey(row.key) && row.key === row.tier_key ? priceIdFor(row.tier_key) : null
}

export async function planForStripePrice(db: Db, priceId: string | null | undefined): Promise<PlanRow | null> {
  if (!priceId) return null
  const rows = await loadPlans(db)
  const own = rows.find(p => p.stripe_price_id === priceId)
  if (own) return own
  const tier = planForPrice(priceId)
  return tier ? rows.find(p => p.key === tier && !p.stripe_price_id) ?? null : null
}

/** The plan row a subscription is on (its plan_key, else the tier's own plan). */
export async function planOfSubscription(db: Db, sub: { plan_key?: string | null; plan: string | null }): Promise<PlanRow | null> {
  const rows = await loadPlans(db)
  return rows.find(p => p.key === sub.plan_key) ?? rows.find(p => p.key === sub.plan) ?? null
}

/** Whole-currency display of a plan price ("$149"), or with cents when it has them. */
export function formatPrice(cents: number, currency = 'usd'): string {
  const symbol = currency === 'usd' ? '$' : currency === 'eur' ? '€' : currency === 'gbp' ? '£' : `${currency.toUpperCase()} `
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${symbol}${abs % 100 === 0 ? (abs / 100).toFixed(0) : (abs / 100).toFixed(2)}`
}
