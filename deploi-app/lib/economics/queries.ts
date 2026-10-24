/**
 * Staff-only economics reads. Runs as the signed-in staff user (RLS: is_staff()). Tables that other
 * streams create (engagements, website_engagements, website_labor) are checked first and reported as
 * "not available yet" when missing. Never import this from a client route.
 */
import type { Db } from '../db'
import { tableExists, columnExists, tableColumns, str, numOrNull, NOT_AVAILABLE } from '../dashboard/optional'
import {
  DEFAULT_RATES, RATE_KEYS, type Rates, type RateKey, type LaborEntry, type CostEntry, type RevenueEntry,
  agencyRollup, monthlyContribution, implementationContribution, reviewTimePerCase, supportTimePerAgency, costPerCompletedWorkflow, websiteContribution, hoursByKind,
} from './calc'

export type RateRow = { key: RateKey; label: string; hourly_cents: number; effective_from: string; updated_at: string; updated_by: string | null }

export async function loadRates(db: Db): Promise<{ rates: Rates; rows: RateRow[] }> {
  const rows = await db.query<RateRow>('select key, label, hourly_cents, effective_from::text, updated_at::text, updated_by from internal_rates order by key')
  const rates = { ...DEFAULT_RATES }
  for (const r of rows) if (RATE_KEYS.includes(r.key)) rates[r.key] = Number(r.hourly_cents)
  return { rates, rows }
}

export async function saveRate(db: Db, key: RateKey, hourlyCents: number, updatedBy: string | null) {
  if (!RATE_KEYS.includes(key)) throw new Error('unknown rate key')
  if (!Number.isInteger(hourlyCents) || hourlyCents < 0) throw new Error('rate must be a non-negative whole number of cents')
  await db.query('update internal_rates set hourly_cents = $2, updated_at = now(), updated_by = $3, effective_from = current_date where key = $1', [key, hourlyCents, updatedBy])
}

export type LaborRow = LaborEntry & { id: string; note: string | null; logged_by: string | null; logged_on: string; created_at: string }
export type CostRow = CostEntry & { id: string; note: string | null; logged_by: string | null; incurred_on: string; created_at: string }
export type RevenueRow = RevenueEntry & { id: string; note: string | null; logged_by: string | null; created_at: string }

export async function loadEntries(db: Db) {
  const labor = await db.query<LaborRow>('select id, agency_id, ref_type, ref_id, kind, hours::float as hours, note, logged_by, logged_on::text, created_at::text from labor_entries order by logged_on desc, created_at desc')
  const costs = await db.query<CostRow>('select id, agency_id, ref_type, ref_id, kind, amount_cents, note, logged_by, incurred_on::text, created_at::text from cost_entries order by incurred_on desc, created_at desc')
  const revenue = await db.query<RevenueRow>('select id, agency_id, ref_type, ref_id, kind, amount_cents, status, is_mock, collected_on::text, note, logged_by, created_at::text from revenue_entries order by created_at desc')
  return { labor, costs, revenue }
}

export type AgencyEconomics = ReturnType<typeof agencyRollup> & {
  name: string
  month: ReturnType<typeof monthlyContribution>
  reviewHoursPerCase: number | null
  casesDecided: number
  supportHours: number
  costPerCompletedWorkflowCents: number | null
  completedWorkflows: number | null
  completedNote: string | null
  engagements: (ReturnType<typeof implementationContribution> & { serviceKey: string | null; status: string | null })[]
  engagementsNote: string | null
}

export type WebsiteEconomics = { id: string; status: string | null; paymentStatus: string | null; isMock: boolean } & ReturnType<typeof websiteContribution>

export type EconomicsOverview = {
  rates: Rates
  month: string
  agencies: AgencyEconomics[]
  websites: WebsiteEconomics[]
  websitesNote: string | null
  unassigned: { hours: ReturnType<typeof hoursByKind>; costCents: number }
}

const monthKey = (d: Date) => d.toISOString().slice(0, 7)

export async function loadEconomicsOverview(db: Db, now = new Date()): Promise<EconomicsOverview> {
  const { rates } = await loadRates(db)
  const { labor, costs, revenue } = await loadEntries(db)
  const month = monthKey(now)
  const since = new Date(now.getTime() - 30 * 86400e3)
  const agencies = await db.query<{ id: string; name: string }>('select id, name from agencies order by name')

  // proposed_actions.decided_at exists in the foundation; guard anyway (ops may reshape states).
  const hasDecided = await columnExists(db, 'proposed_actions', 'decided_at')
  const hasSimulated = await columnExists(db, 'proposed_actions', 'simulated')
  const decided = hasDecided
    ? await db.query<{ agency_id: string; n: string }>("select agency_id, count(*)::text as n from proposed_actions where decided_at >= $1 group by agency_id", [since])
    : []
  const completed = hasSimulated
    ? await db.query<{ agency_id: string; n: string }>("select agency_id, count(*)::text as n from proposed_actions where status = 'delivered' and simulated = false group by agency_id")
    : []

  const hasEngagements = await tableExists(db, 'engagements')
  const engagementRows = hasEngagements
    ? await db.query<{ id: string; agency_id: string; service_key: string | null; status: string | null }>('select id, agency_id, service_key::text, status::text from engagements order by created_at')
    : []

  const support = supportTimePerAgency(labor)
  const out: AgencyEconomics[] = agencies.map(a => {
    const roll = agencyRollup(a.id, revenue, labor, costs, rates)
    const cases = Number(decided.find(d => d.agency_id === a.id)?.n ?? 0)
    const done = hasSimulated ? Number(completed.find(d => d.agency_id === a.id)?.n ?? 0) : null
    const myEngagements = engagementRows.filter(e => e.agency_id === a.id)
    return {
      ...roll, name: a.name,
      month: monthlyContribution(a.id, month, revenue, labor, costs, rates),
      reviewHoursPerCase: reviewTimePerCase(roll.hours.review, cases), casesDecided: cases,
      supportHours: support[a.id] ?? 0,
      completedWorkflows: done,
      costPerCompletedWorkflowCents: done === null ? null : costPerCompletedWorkflow(roll.laborCents, roll.costCents, done),
      completedNote: hasSimulated ? null : `delivery verification ${NOT_AVAILABLE} (proposed_actions.simulated missing)`,
      engagements: myEngagements.map(e => ({ ...implementationContribution(e.id, revenue, labor, costs, rates), serviceKey: e.service_key, status: e.status })),
      engagementsNote: hasEngagements ? null : `engagements table ${NOT_AVAILABLE}`,
    }
  })

  // Website Improvement: price (default $500) vs website_labor hours × rate, when the web stream's tables exist.
  let websites: WebsiteEconomics[] = []
  let websitesNote: string | null = null
  if (await tableExists(db, 'website_engagements')) {
    const cols = await tableColumns(db, 'website_engagements')
    const hasLabor = await tableExists(db, 'website_labor')
    const rows = await db.query<{ row: Record<string, unknown> }>('select to_jsonb(w) as row from website_engagements w order by w.created_at desc limit 50')
    const hours = hasLabor
      ? await db.query<{ website_engagement_id: string; h: string }>('select website_engagement_id, coalesce(sum(hours), 0)::text as h from website_labor group by website_engagement_id')
      : []
    websites = rows.map(({ row }) => {
      const id = str(row, 'id') ?? ''
      const paymentStatus = cols.has('payment_status') ? str(row, 'payment_status') : null
      const isMock = cols.has('payment_is_mock') ? row.payment_is_mock === true : paymentStatus === 'mock_paid'
      const paid = paymentStatus === 'paid' && !isMock
      const h = Number(hours.find(x => x.website_engagement_id === id)?.h ?? 0)
      return { id, status: str(row, 'status'), paymentStatus, isMock, ...websiteContribution(numOrNull(row, 'price_cents') ?? 50000, h, rates, paid) }
    })
    if (!hasLabor) websitesNote = `website_labor ${NOT_AVAILABLE}: hours show as 0`
  } else {
    websitesNote = `website_engagements ${NOT_AVAILABLE}`
  }

  const unassignedLabor = labor.filter(l => !l.agency_id)
  const unassignedCosts = costs.filter(c => !c.agency_id)
  return { rates, month, agencies: out, websites, websitesNote, unassigned: { hours: hoursByKind(unassignedLabor), costCents: unassignedCosts.reduce((a, c) => a + c.amount_cents, 0) } }
}
