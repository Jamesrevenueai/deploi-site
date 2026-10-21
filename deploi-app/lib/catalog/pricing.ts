/**
 * Commercial defaults. These are DRAFT defaults from the brief; they are configurable
 * through environment variables (and, where a settings row exists, through /staff/setup),
 * never silently changed in code. Exact scope determines the final quote.
 */
const e = (k: string) => (process.env[k] ?? '').trim()
const num = (k: string, d: number) => { const v = Number(e(k)); return Number.isFinite(v) && v > 0 ? v : d }

export type PriceRange = { min: number; max: number }

export type Pricing = {
  assessment: PriceRange & { includes: string[]; creditTermDays: number }
  build: PriceRange & { includes: string[]; fixPeriodDays: number }
  management: PriceRange & { includes: string[]; initialTermMonths: number }
  website: { price: number; hoursBudget: number; targetBusinessDays: number; standalone: true; creditsTowardOtherServices: false }
}

export function getPricing(): Pricing {
  return {
    assessment: {
      min: num('ASSESSMENT_PRICE_MIN', 1500), max: num('ASSESSMENT_PRICE_MAX', 2500),
      includes: ['Diagnostic (one referral and one visit traced, plus broader records where available)', 'Written report', 'Review meeting'],
      creditTermDays: num('ASSESSMENT_CREDIT_TERM_DAYS', 60),
    },
    build: {
      min: num('BUILD_PRICE_MIN', 3000), max: num('BUILD_PRICE_MAX', 7000),
      includes: ['Configuration', 'Supported connections', 'Testing', 'Training', 'Documentation', 'In-scope fixes for the fix period'],
      fixPeriodDays: num('BUILD_FIX_PERIOD_DAYS', 30),
    },
    management: {
      min: num('MANAGEMENT_PRICE_MIN', 500), max: num('MANAGEMENT_PRICE_MAX', 1500),
      includes: ['Defined workers', 'Defined volume', 'Defined support coverage', 'Defined responsibilities'],
      initialTermMonths: num('MANAGEMENT_INITIAL_TERM_MONTHS', 3),
    },
    website: {
      price: num('WEBSITE_IMPROVEMENT_PRICE', 500), hoursBudget: num('WEBSITE_IMPROVEMENT_HOURS', 5), targetBusinessDays: num('WEBSITE_IMPROVEMENT_TARGET_DAYS', 5),
      standalone: true, creditsTowardOtherServices: false,
    },
  }
}

export const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
export const range = (r: PriceRange) => `${money(r.min)}–${money(r.max)}`

/** Scope considerations that are quoted separately; never bundled into the lowest price. */
export const SCOPE_CONSIDERATIONS = [
  { key: 'implementation', label: 'Implementation', note: 'Configuring and connecting one defined service. Priced in the Build.' },
  { key: 'maintenance', label: 'Routine maintenance', note: 'Keeping a running service healthy: rule updates, template tweaks, import fixes. Part of Monthly Management within the defined volume.' },
  { key: 'human_review', label: 'Human review', note: 'A person approving proposed actions and handling exceptions. Priced by expected volume; not unlimited.' },
  { key: 'operating', label: 'Production operating responsibility', note: 'Who answers when something breaks, during which hours. Set in the engagement; no continuous coverage is implied.' },
  { key: 'new_development', label: 'New development', note: 'New workers, new integrations, new reports. Always a separate quote.' },
] as const

export const NOT_INCLUDED_IN_LOWEST_PRICE = ['all workers', 'unlimited volume', 'continuous support', 'custom integrations'] as const
