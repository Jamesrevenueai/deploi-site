/**
 * Pricing v2 (2026-11-22): the one source for prices, allowances and which agent each plan unlocks.
 * The marketing site, the in-app billing page and the Shopify listing read lib/pricing/catalog.json; the server
 * enforces the same numbers (plans table rows seeded by migration 066 carry them, and a test keeps them equal).
 *
 *   Store  (Shopify Billing API): Starter / Growth / Pro, 14-day trial, yearly = 2 months free,
 *          overage $5 per 100 actions as a Shopify usage charge up to the merchant's capped amount.
 *   Office (Stripe):              Solo / Team / Business, actions + texts, overage $5/100 actions and $3/100 texts
 *          up to the customer's cap, optional $499 setup (Solo/Team), 20% off when the customer also has Store.
 */
import catalog from './catalog.json'

export type Suite = 'store' | 'office'
export type StorePlanKey = 'starter' | 'growth' | 'pro'
export type OfficePlanKey = 'solo' | 'team' | 'business'
export type PlanKey = StorePlanKey | OfficePlanKey
export type Interval = 'month' | 'year'

export type StorePlan = { key: StorePlanKey; name: string; monthlyCents: number; actions: number; customAgents: number | null; stores: number | null; agents: string[] }
export type OfficePlan = { key: OfficePlanKey; name: string; monthlyCents: number; actions: number; texts: number; crew: number | null; customAgents: number | null; setupIncluded?: boolean }

export const CATALOG = catalog as unknown as {
  version: number; currency: string
  action: { definition: string; free: string }
  store: { billedVia: 'shopify'; trialDays: number; yearlyMonthsFree: number; overage: { unitActions: number; priceCents: number }; plans: StorePlan[] }
  office: {
    billedVia: 'stripe'; trialDays: number; yearlyMonthsFree: number
    overage: { unitActions: number; actionPriceCents: number; unitTexts: number; textPriceCents: number }
    setup: { priceCents: number; plans: OfficePlanKey[]; includedIn: OfficePlanKey[] }
    bundleDiscountPercent: number
    agentCatalog: { key: string; name: string; minPlan: OfficePlanKey; job: string }[]
    plans: OfficePlan[]
  }
}

export const STORE_PLANS = CATALOG.store.plans
export const OFFICE_PLANS = CATALOG.office.plans
export const STORE_ORDER: StorePlanKey[] = ['starter', 'growth', 'pro']
export const OFFICE_ORDER: OfficePlanKey[] = ['solo', 'team', 'business']

export const isStorePlan = (k: unknown): k is StorePlanKey => STORE_ORDER.includes(k as StorePlanKey)
export const isOfficePlan = (k: unknown): k is OfficePlanKey => OFFICE_ORDER.includes(k as OfficePlanKey)
export const suiteOf = (k: PlanKey): Suite => (isStorePlan(k) ? 'store' : 'office')
export const storePlan = (k: StorePlanKey) => STORE_PLANS.find(p => p.key === k)!
export const officePlan = (k: OfficePlanKey) => OFFICE_PLANS.find(p => p.key === k)!
export const planName = (k: PlanKey) => (isStorePlan(k) ? storePlan(k).name : officePlan(k).name)

/** Yearly billing: 2 months free (10 x monthly). */
export const yearlyCents = (monthlyCents: number, monthsFree = CATALOG.store.yearlyMonthsFree) => monthlyCents * (12 - monthsFree)
export const priceCents = (k: PlanKey, interval: Interval = 'month') => {
  const m = isStorePlan(k) ? storePlan(k).monthlyCents : officePlan(k).monthlyCents
  return interval === 'year' ? yearlyCents(m, isStorePlan(k) ? CATALOG.store.yearlyMonthsFree : CATALOG.office.yearlyMonthsFree) : m
}
/** Office price with the 20% Store bundle discount when the customer also has a Store plan. */
export const officePriceCents = (k: OfficePlanKey, interval: Interval, hasStore: boolean) => {
  const base = priceCents(k, interval)
  return hasStore ? Math.round(base * (100 - CATALOG.office.bundleDiscountPercent) / 100) : base
}
/** The optional one-time setup fee (Solo and Team; included in Business). */
export const setupFeeCents = (k: OfficePlanKey) => (CATALOG.office.setup.plans.includes(k) ? CATALOG.office.setup.priceCents : 0)

/** The cheapest Store plan that unlocks a library agent, or null when no Store plan does. */
export function storePlanFor(agentKey: string): StorePlanKey | null {
  for (const k of STORE_ORDER) if (storePlan(k).agents.includes(agentKey)) return k
  return null
}
export const storeAgentAllowed = (plan: StorePlanKey, agentKey: string) => storePlan(plan).agents.includes(agentKey)
/** Office agents a plan unlocks (Business: all, plus unlimited custom agents). */
export function officeAgentsFor(plan: OfficePlanKey): string[] {
  const rank = OFFICE_ORDER.indexOf(plan)
  return CATALOG.office.agentCatalog.filter(a => OFFICE_ORDER.indexOf(a.minPlan) <= rank).map(a => a.key)
}
export const officeAgentAllowed = (plan: OfficePlanKey, agentKey: string) => officeAgentsFor(plan).includes(agentKey)
export const officePlanFor = (agentKey: string): OfficePlanKey | null => CATALOG.office.agentCatalog.find(a => a.key === agentKey)?.minPlan ?? null

/** Overage cost of `over` extra units, rounded up to whole blocks of 100. */
export function overageCents(over: number, unit: number, blockCents: number) {
  return over <= 0 ? 0 : Math.ceil(over / unit) * blockCents
}
/** How many extra units a customer-set cap pays for (whole blocks only). */
export const unitsForCap = (capCents: number, unit: number, blockCents: number) => Math.floor(Math.max(0, capCents) / blockCents) * unit

export const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`
