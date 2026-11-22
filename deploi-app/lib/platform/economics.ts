/**
 * Unit economics per organization per month (staff only): what an organization pays, what it costs to
 * serve, and what each verified resolution costs.
 *
 *   revenue               the monthly price of the plan of an active or past-due subscription (Stripe or
 *                         Shopify), from the plans table; trialing, cancelled and missing subscriptions are 0
 *   AI cost               ai_usage cost for the month (every call that was not refused)
 *   provider/API cost     provider API calls (workflow_costs) x ECON_PROVIDER_CALL_USD (per connector:
 *                         ECON_PROVIDER_CALL_USD_<CONNECTOR>), plus job runs x ECON_JOB_RUN_USD
 *   email cost            emails accepted x ECON_EMAIL_USD
 *   verified resolutions  cases closed as resolved in the month (a resolved case always carries
 *                         verification evidence: cases_resolved_has_outcome)
 *   cost per resolution   variable cost / verified resolutions (null without resolutions)
 *   gross margin          (revenue - variable cost) / revenue (null without revenue)
 * Target: $15-$40 of variable cost a month for a $249 plan, scaled by the organization's plan price
 * (ECON_TARGET_MIN_USD, ECON_TARGET_MAX_USD, ECON_TARGET_PLAN_USD). Flags: above_target (over the scaled
 * maximum), negative_margin (cost above revenue), no_revenue_with_cost (paying nothing, costing money).
 * Unit prices are estimates for the owner to replace with invoices; nothing here is billed.
 */
import type { Db } from '../db'

type Env = Record<string, string | undefined>
const num = (e: Env, k: string, d: number) => { const s = (e[k] ?? '').trim(); const n = Number(s); return s !== '' && Number.isFinite(n) && n >= 0 ? n : d }

export function unitPrices(e: Env = process.env) {
  return {
    jobRunUsd: num(e, 'ECON_JOB_RUN_USD', 0.0002),
    providerCallUsd: num(e, 'ECON_PROVIDER_CALL_USD', 0.0001),
    providerCallUsdFor: (connector: string) => num(e, `ECON_PROVIDER_CALL_USD_${connector.toUpperCase()}`, num(e, 'ECON_PROVIDER_CALL_USD', 0.0001)),
    emailUsd: num(e, 'ECON_EMAIL_USD', 0.0009),
    targetMinUsd: num(e, 'ECON_TARGET_MIN_USD', 15),
    targetMaxUsd: num(e, 'ECON_TARGET_MAX_USD', 40),
    targetPlanUsd: num(e, 'ECON_TARGET_PLAN_USD', 249),
  }
}
export type UnitPrices = ReturnType<typeof unitPrices>

export type OrgMonthInputs = {
  orgId: string; orgName: string; plan: string | null; subscriptionStatus: string | null
  revenueCents: number; aiCostUsd: number; aiCalls: number; jobRuns: number; providerCalls: Record<string, number>; emailsSent: number; verifiedResolutions: number
}
export type OrgEconomics = OrgMonthInputs & {
  revenueUsd: number; providerCostUsd: number; jobCostUsd: number; emailCostUsd: number; variableCostUsd: number
  costPerResolutionUsd: number | null; grossMarginPct: number | null; target: { minUsd: number; maxUsd: number }; flags: string[]
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4

/** Pure: the economics of one organization's month. */
export function computeEconomics(i: OrgMonthInputs, p: UnitPrices = unitPrices()): OrgEconomics {
  const revenueUsd = i.revenueCents / 100
  const providerCostUsd = Object.entries(i.providerCalls).reduce((s, [c, n]) => s + n * p.providerCallUsdFor(c), 0)
  const jobCostUsd = i.jobRuns * p.jobRunUsd
  const emailCostUsd = i.emailsSent * p.emailUsd
  const variableCostUsd = i.aiCostUsd + providerCostUsd + jobCostUsd + emailCostUsd
  const scale = revenueUsd > 0 ? revenueUsd / p.targetPlanUsd : 1
  const target = { minUsd: r4(p.targetMinUsd * scale), maxUsd: r4(p.targetMaxUsd * scale) }
  const flags: string[] = []
  if (variableCostUsd > target.maxUsd) flags.push('above_target')
  if (revenueUsd > 0 && variableCostUsd > revenueUsd) flags.push('negative_margin')
  if (revenueUsd === 0 && variableCostUsd > 0) flags.push('no_revenue_with_cost')
  return {
    ...i, revenueUsd: r4(revenueUsd), aiCostUsd: r4(i.aiCostUsd), providerCostUsd: r4(providerCostUsd), jobCostUsd: r4(jobCostUsd), emailCostUsd: r4(emailCostUsd), variableCostUsd: r4(variableCostUsd),
    costPerResolutionUsd: i.verifiedResolutions > 0 ? r4(variableCostUsd / i.verifiedResolutions) : null,
    grossMarginPct: revenueUsd > 0 ? Math.round(((revenueUsd - variableCostUsd) / revenueUsd) * 1000) / 10 : null,
    target, flags,
  }
}

/** `YYYY-MM` -> [first day, first day of the next month] (UTC). */
export function monthRange(month: string): [string, string] {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error('month must be YYYY-MM')
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
  const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1))
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]
}

export const currentMonth = (d = new Date()) => d.toISOString().slice(0, 7)

/** Every merchant organization (not deleted) for one month, highest variable cost first. Service-role connection. */
export async function economicsReport(db: Db, month: string, prices: UnitPrices = unitPrices()): Promise<{ month: string; prices: Omit<UnitPrices, 'providerCallUsdFor'>; orgs: OrgEconomics[]; totals: { revenueUsd: number; variableCostUsd: number; verifiedResolutions: number; flagged: number } }> {
  const [from, to] = monthRange(month)
  const orgs = await db.query<{ id: string; name: string; plan_key: string | null; plan_tier: string | null; status: string | null; sub_plan: string | null }>(
    `select g.id, g.name, g.plan_key, g.plan_tier, s.status, s.plan as sub_plan from agencies g
     left join lateral (select status, plan from billing_subscriptions b where b.org_id = g.id order by (b.status in ('active','past_due')) desc, b.updated_at desc nulls last limit 1) s on true
     where g.org_type = 'merchant' and g.deleted_at is null order by g.name`)
  const plans = await db.query<{ key: string; monthly_price_cents: number }>('select key, monthly_price_cents from plans')
  const price = new Map(plans.map(p => [p.key, p.monthly_price_cents]))
  const ai = new Map((await db.query<{ org_id: string; cost: string; calls: string }>(`select org_id, sum(cost_usd)::text as cost, count(*)::text as calls from ai_usage where created_at >= $1 and created_at < $2 and outcome <> 'refused' group by org_id`, [from, to])).map(r => [r.org_id, r]))
  const wf = await db.query<{ org_id: string; metric: string; connector: string; count: string }>(`select org_id, metric, connector, sum(count)::text as count from workflow_costs where month >= $1 and month < $2 group by 1, 2, 3`, [from, to])
  const resolved = new Map((await db.query<{ org_id: string; n: string }>(`select org_id, count(*)::text as n from cases where status = 'resolved' and closed_at >= $1 and closed_at < $2 group by org_id`, [from, to])).map(r => [r.org_id, Number(r.n)]))
  const out = orgs.map(o => {
    const plan = o.plan_key ?? o.sub_plan ?? o.plan_tier
    const paying = o.status === 'active' || o.status === 'past_due'
    const mine = wf.filter(w => w.org_id === o.id)
    const providerCalls: Record<string, number> = {}
    for (const w of mine.filter(w => w.metric === 'provider_call')) providerCalls[w.connector || 'other'] = Number(w.count)
    return computeEconomics({
      orgId: o.id, orgName: o.name, plan, subscriptionStatus: o.status, revenueCents: paying && plan ? price.get(plan) ?? 0 : 0,
      aiCostUsd: Number(ai.get(o.id)?.cost ?? 0), aiCalls: Number(ai.get(o.id)?.calls ?? 0),
      jobRuns: Number(mine.find(w => w.metric === 'job_run')?.count ?? 0), providerCalls, emailsSent: Number(mine.find(w => w.metric === 'email_sent')?.count ?? 0),
      verifiedResolutions: resolved.get(o.id) ?? 0,
    }, prices)
  }).sort((a, b) => b.variableCostUsd - a.variableCostUsd)
  const { providerCallUsdFor: _f, ...shown } = prices
  void _f
  return { month, prices: shown, orgs: out, totals: {
    revenueUsd: r4(out.reduce((s, o) => s + o.revenueUsd, 0)), variableCostUsd: r4(out.reduce((s, o) => s + o.variableCostUsd, 0)),
    verifiedResolutions: out.reduce((s, o) => s + o.verifiedResolutions, 0), flagged: out.filter(o => o.flags.length).length } }
}
