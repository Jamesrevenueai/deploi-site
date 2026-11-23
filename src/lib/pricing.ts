/**
 * Plan prices and allowances as the website shows them. Every number comes from the SAME catalog the app bills from
 * (deploi-app/lib/pricing/catalog.json); only the wording around the numbers lives here.
 */
import raw from '../../deploi-app/lib/pricing/catalog.json'

type StorePlanRaw = { key: string; name: string; monthlyCents: number; actions: number; customAgents: number | null; stores: number | null; agents: string[] }
type OfficePlanRaw = { key: string; name: string; monthlyCents: number; actions: number; texts: number; crew: number | null; customAgents: number | null; setupIncluded?: boolean }
export type Catalog = {
  version: number
  currency: string
  store: { trialDays: number; yearlyMonthsFree: number; overage: { unitActions: number; priceCents: number }; plans: StorePlanRaw[] }
  office: {
    trialDays: number; yearlyMonthsFree: number; bundleDiscountPercent: number
    overage: { unitActions: number; actionPriceCents: number; unitTexts: number; textPriceCents: number }
    setup: { priceCents: number; plans: string[]; includedIn: string[] }
    plans: OfficePlanRaw[]
  }
}

export const CATALOG = raw as Catalog

export type Product = 'store' | 'office'
export type ShownPlan = { key: string; name: string; badge: string; price: string; actions: string; who: string; feats: string[]; hot: boolean }

/** $79, $199, $5 … (whole dollars; cents shown only when there are any). */
export const dollars = (cents: number) => `$${cents % 100 === 0 ? (cents / 100).toLocaleString('en-US') : (cents / 100).toFixed(2)}`
const n = (x: number) => x.toLocaleString('en-US')
const customAgents = (c: number | null) => (c == null ? 'Unlimited custom agents' : `${c} custom agent${c === 1 ? '' : 's'}`)
const byKey = <T extends { key: string }>(list: T[], key: string): T => {
  const p = list.find(x => x.key === key)
  if (!p) throw new Error(`pricing catalog has no plan "${key}"`)
  return p
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function storePlans(): ShownPlan[] {
  const plans = CATALOG.store.plans
  const starter = byKey(plans, 'starter'), growth = byKey(plans, 'growth'), pro = byKey(plans, 'pro')
  const base = (p: StorePlanRaw) => ({ key: p.key, name: p.name, price: dollars(p.monthlyCents), actions: `${n(p.actions)} actions / month` })
  return [
    { ...base(starter), badge: 'New stores', who: 'For stores getting their first agents to work.', hot: false,
      feats: [`${starter.agents.length} core agents: orders, inventory, support, listings, suppliers, insights, store health`, customAgents(starter.customAgents), 'Text and voice chat with every agent', 'Weekly time-saved report'] },
    { ...base(growth), badge: 'Most popular', who: 'For growing stores that want most of the work handled.', hot: true,
      feats: [`Everything in ${starter.name}`, '+ Returns, Campaign, Promo Manager, Payout & Fees agents', customAgents(growth.customAgents), 'Agent updates by text to your phone', 'Priority support'] },
    { ...base(pro), badge: 'High volume', who: 'For established brands running the full library.', hot: false,
      feats: ['Every agent, including AI Visibility', customAgents(pro.customAgents), pro.stores == null ? 'Multiple stores' : `Up to ${pro.stores} stores`, 'Live onboarding call', 'Dedicated success manager'] },
  ]
}

function officePlans(): ShownPlan[] {
  const plans = CATALOG.office.plans
  const solo = byKey(plans, 'solo'), team = byKey(plans, 'team'), business = byKey(plans, 'business')
  const base = (p: OfficePlanRaw) => ({ key: p.key, name: `Office ${p.name}`, price: dollars(p.monthlyCents), actions: `${n(p.actions)} actions · ${n(p.texts)} texts / month` })
  return [
    { ...base(solo), badge: 'One owner', who: 'For a solo agent, owner-operator or small office.', hot: false,
      feats: ['Lead Responder, Invoice Runner, CRM Follow-up, Owner Updates', 'Texts and voice notes to your phone', 'Outlook, CRM and QuickBooks connections', customAgents(solo.customAgents)] },
    { ...base(team), badge: 'Most popular', who: `For crews and offices up to ${team.crew} people.`, hot: true,
      feats: [`Everything in ${solo.name}`, '+ Dispatch Coordinator and Books Reconciler', `Up to ${team.crew} crew members get job texts`, customAgents(team.customAgents), 'Priority support'] },
    { ...base(business), badge: 'Multi-crew', who: 'For property managers and multi-crew companies.', hot: false,
      feats: ['Every Office agent', business.crew == null ? 'Unlimited crew members' : `Up to ${business.crew} crew members`, customAgents(business.customAgents), ...(business.setupIncluded ? ['Done-for-you setup included'] : []), 'Dedicated success manager'] },
  ]
}

export const STORE_PLANS = storePlans()
export const OFFICE_PLANS = officePlans()
export const plansFor = (p: Product) => (p === 'store' ? STORE_PLANS : OFFICE_PLANS)

const so = CATALOG.store.overage
const oo = CATALOG.office.overage
const setupPlanNames = CATALOG.office.setup.plans.map(k => cap(byKey(CATALOG.office.plans, k).name)).join(' and ')

/** "$5 per 100" — the store's extra-action price, also quoted in the FAQ. */
export const STORE_OVERAGE = `${dollars(so.priceCents)} per ${n(so.unitActions)}`
export const OVERAGE: Record<Product, { title: string; text: string }> = {
  store: { title: 'Extra actions', text: `${STORE_OVERAGE} extra actions. Set a monthly cap so you are never surprised.` },
  office: {
    title: 'Extra actions and texts',
    text: `${dollars(oo.actionPriceCents)} per ${n(oo.unitActions)} extra actions, ${dollars(oo.textPriceCents)} per ${n(oo.unitTexts)} extra texts. Optional done-for-you setup on ${setupPlanNames}: ${dollars(CATALOG.office.setup.priceCents)} one time.`,
  },
}
export const BUNDLE_TEXT = `Run both and save ${CATALOG.office.bundleDiscountPercent}% on the Office plan. Pay yearly and get ${CATALOG.office.yearlyMonthsFree} months free.`
export const TRIAL_DAYS = CATALOG.store.trialDays
