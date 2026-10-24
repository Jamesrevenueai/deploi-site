/**
 * Pure economics rules. No database access; every function takes plain rows and the current rates.
 * Money is integer cents. Mock payments (is_mock or status 'mock') are never collected revenue.
 * Every contribution figure carries CONTRIBUTION_LABEL: it is not net profit and excludes unrecorded overhead.
 */
export const CONTRIBUTION_LABEL = 'Contribution (not net profit; excludes unrecorded overhead)'

export const LABOR_KINDS = ['assessment', 'build', 'review', 'support', 'troubleshooting'] as const
export type LaborKind = (typeof LABOR_KINDS)[number]
export type RateKey = `${LaborKind}_labor`
export const RATE_KEYS: RateKey[] = LABOR_KINDS.map(k => `${k}_labor` as RateKey)
export const RATE_LABELS: Record<RateKey, string> = {
  assessment_labor: 'Assessment labor', build_labor: 'Build labor', review_labor: 'Review labor',
  support_labor: 'Support labor', troubleshooting_labor: 'Troubleshooting labor',
}
/** hourly cents per rate key */
export type Rates = Record<RateKey, number>
export const DEFAULT_RATES: Rates = { assessment_labor: 8500, build_labor: 8500, review_labor: 8500, support_labor: 8500, troubleshooting_labor: 8500 }

export const COST_KINDS = ['hosting', 'model_usage', 'third_party', 'credit', 'refund'] as const
export type CostKind = (typeof COST_KINDS)[number]
export const REVENUE_KINDS = ['assessment_fee', 'setup_fee', 'monthly_fee', 'website_fee', 'other'] as const
export type RevenueKind = (typeof REVENUE_KINDS)[number]
export const REVENUE_STATUSES = ['projected', 'invoiced', 'collected', 'mock'] as const
export type RevenueStatus = (typeof REVENUE_STATUSES)[number]
export const REF_TYPES = ['assessment', 'engagement', 'website', 'agency', 'general'] as const
export type RefType = (typeof REF_TYPES)[number]

export type LaborEntry = { kind: LaborKind; hours: number; agency_id?: string | null; ref_type?: string | null; ref_id?: string | null; logged_on?: string | null }
export type CostEntry = { kind: CostKind; amount_cents: number; agency_id?: string | null; ref_type?: string | null; ref_id?: string | null; incurred_on?: string | null }
export type RevenueEntry = { kind: RevenueKind; amount_cents: number; status: RevenueStatus; is_mock: boolean; agency_id?: string | null; ref_type?: string | null; ref_id?: string | null; collected_on?: string | null }

export const isMock = (r: Pick<RevenueEntry, 'status' | 'is_mock'>) => r.is_mock || r.status === 'mock'
export const isCollected = (r: Pick<RevenueEntry, 'status' | 'is_mock'>) => !isMock(r) && r.status === 'collected'
export const isProjected = (r: Pick<RevenueEntry, 'status' | 'is_mock'>) => !isMock(r) && (r.status === 'projected' || r.status === 'invoiced')

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
export const round2 = (n: number) => Math.round(n * 100) / 100

export function collectedCents(rev: RevenueEntry[], kind?: RevenueKind): number {
  return sum(rev.filter(r => isCollected(r) && (!kind || r.kind === kind)).map(r => r.amount_cents))
}
export function projectedCents(rev: RevenueEntry[], kind?: RevenueKind): number {
  return sum(rev.filter(r => isProjected(r) && (!kind || r.kind === kind)).map(r => r.amount_cents))
}
export function mockCents(rev: RevenueEntry[]): number {
  return sum(rev.filter(isMock).map(r => r.amount_cents))
}

export function hoursByKind(labor: LaborEntry[]): Record<LaborKind, number> {
  const out = Object.fromEntries(LABOR_KINDS.map(k => [k, 0])) as Record<LaborKind, number>
  for (const l of labor) out[l.kind] = round2(out[l.kind] + Number(l.hours || 0))
  return out
}

/** Labor valued at the current rate for its kind, in cents (rounded). */
export function laborCents(labor: LaborEntry[], rates: Rates, kinds: readonly LaborKind[] = LABOR_KINDS): number {
  return Math.round(sum(labor.filter(l => kinds.includes(l.kind)).map(l => Number(l.hours || 0) * (rates[`${l.kind}_labor`] ?? 0))))
}

export function costCents(costs: CostEntry[], kinds: readonly CostKind[] = COST_KINDS): number {
  return sum(costs.filter(c => kinds.includes(c.kind)).map(c => c.amount_cents))
}

const inMonth = (d: string | null | undefined, month: string) => Boolean(d && String(d).slice(0, 7) === month)
const forRef = <T extends { ref_type?: string | null; ref_id?: string | null }>(xs: T[], refType: string, refId: string) => xs.filter(x => x.ref_type === refType && x.ref_id === refId)

export type Contribution = { label: typeof CONTRIBUTION_LABEL; contributionCents: number }

/** Implementation contribution per engagement = collected setup fee − build labor × rate − implementation costs. */
export function implementationContribution(engagementRef: string, rev: RevenueEntry[], labor: LaborEntry[], costs: CostEntry[], rates: Rates) {
  const r = forRef(rev, 'engagement', engagementRef)
  const l = forRef(labor, 'engagement', engagementRef)
  const c = forRef(costs, 'engagement', engagementRef)
  const collectedSetupCents = collectedCents(r, 'setup_fee')
  const projectedSetupCents = projectedCents(r, 'setup_fee')
  const buildHours = hoursByKind(l).build
  const buildLaborCents = laborCents(l, rates, ['build'])
  const implementationCostCents = costCents(c)
  return {
    engagementRef, collectedSetupCents, projectedSetupCents, buildHours, buildLaborCents, implementationCostCents,
    contributionCents: collectedSetupCents - buildLaborCents - implementationCostCents, label: CONTRIBUTION_LABEL,
  }
}

/** Monthly contribution per agency/month = collected monthly fees − (review + support + troubleshooting labor × rates) − hosting/model/third-party costs. */
export function monthlyContribution(agencyId: string, month: string, rev: RevenueEntry[], labor: LaborEntry[], costs: CostEntry[], rates: Rates) {
  const r = rev.filter(x => x.agency_id === agencyId && x.kind === 'monthly_fee' && inMonth(x.collected_on, month))
  const l = labor.filter(x => x.agency_id === agencyId && inMonth(x.logged_on, month))
  const c = costs.filter(x => x.agency_id === agencyId && inMonth(x.incurred_on, month))
  const collectedMonthlyCents = collectedCents(r, 'monthly_fee')
  const projectedMonthlyCents = projectedCents(rev.filter(x => x.agency_id === agencyId && x.kind === 'monthly_fee'), 'monthly_fee')
  const opsLaborCents = laborCents(l, rates, ['review', 'support', 'troubleshooting'])
  const runCostCents = costCents(c, ['hosting', 'model_usage', 'third_party'])
  return {
    agencyId, month, collectedMonthlyCents, projectedMonthlyCents, opsLaborCents, runCostCents,
    hours: hoursByKind(l), contributionCents: collectedMonthlyCents - opsLaborCents - runCostCents, label: CONTRIBUTION_LABEL,
  }
}

/** Review hours ÷ cases decided. null when nothing was decided (never divide by zero). */
export function reviewTimePerCase(reviewHours: number, casesDecided: number): number | null {
  return casesDecided > 0 ? round2(reviewHours / casesDecided) : null
}

/** Support hours per agency (agency_id null → 'unassigned'). */
export function supportTimePerAgency(labor: LaborEntry[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const l of labor) if (l.kind === 'support') { const k = l.agency_id ?? 'unassigned'; out[k] = round2((out[k] ?? 0) + Number(l.hours || 0)) }
  return out
}

/** (labor + costs) ÷ completed workflows (delivered, non-simulated actions). null when none completed. */
export function costPerCompletedWorkflow(laborCentsTotal: number, costCentsTotal: number, completedWorkflows: number): number | null {
  return completedWorkflows > 0 ? Math.round((laborCentsTotal + costCentsTotal) / completedWorkflows) : null
}

/** Whole-agency rollup for the overview page. All-time unless the caller pre-filters the rows. */
export function agencyRollup(agencyId: string, rev: RevenueEntry[], labor: LaborEntry[], costs: CostEntry[], rates: Rates) {
  const r = rev.filter(x => x.agency_id === agencyId)
  const l = labor.filter(x => x.agency_id === agencyId)
  const c = costs.filter(x => x.agency_id === agencyId)
  const collected = collectedCents(r)
  const projected = projectedCents(r)
  const mock = mockCents(r)
  const laborTotal = laborCents(l, rates)
  const costTotal = costCents(c)
  return {
    agencyId, collectedCents: collected, projectedCents: projected, mockCents: mock, mockCount: r.filter(isMock).length,
    hours: hoursByKind(l), laborCents: laborTotal, costCents: costTotal,
    contributionCents: collected - laborTotal - costTotal, label: CONTRIBUTION_LABEL,
  }
}

/** Website Improvement: fixed price vs website_labor hours × rate. Uses the build rate for implementation hours. */
export function websiteContribution(priceCents: number, hours: number, rates: Rates, paid: boolean) {
  const laborValueCents = Math.round(hours * rates.build_labor)
  return { priceCents, hours: round2(hours), laborValueCents, contributionCents: (paid ? priceCents : 0) - laborValueCents, collected: paid, label: CONTRIBUTION_LABEL }
}

export const dollars = (cents: number) => (cents < 0 ? '−' : '') + '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
