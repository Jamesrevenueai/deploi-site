/**
 * Monthly model-provider budgets in USD (UTC calendar month).
 *
 *   organization  ai_budget_overrides (agent_ref '') set by staff, else the plan's aiBudgetUsd
 *                 (plans table, lib/plans/entitlements.ts), else AI_ORG_MONTHLY_USD
 *   agent         ai_budget_overrides for that agent_ref, else the plan's aiAgentBudgetUsd, else half the
 *                 organization's budget (one runaway agent cannot use the whole month)
 * Spend counts reservations still in flight (`pending`) and every finished call; refused calls cost nothing.
 */
import type { Db } from '../db'
import { aiConfig } from './config'

export async function aiBudgets(db: Db, orgId: string, agentRef: string, now = new Date()): Promise<{ orgUsd: number; agentUsd: number; source: { org: 'override' | 'plan' | 'default'; agent: 'override' | 'plan' | 'share' } }> {
  const overrides = await db.query<{ agent_ref: string; monthly_usd: string }>(`select agent_ref, monthly_usd::text from ai_budget_overrides where org_id = $1 and agent_ref in ('', $2)`, [orgId, agentRef])
  const o = overrides.find(r => r.agent_ref === ''), a = overrides.find(r => r.agent_ref === agentRef && agentRef !== '')
  let plan: { aiBudgetUsd: number; aiAgentBudgetUsd: number | null } | null = null
  try {
    const { orgEntitlements } = await import('../plans/entitlements')
    plan = await orgEntitlements(db, orgId, now)
  } catch { plan = null }
  const orgUsd = o ? Number(o.monthly_usd) : plan ? plan.aiBudgetUsd : aiConfig.orgMonthlyUsdDefault
  const agentUsd = a ? Number(a.monthly_usd) : plan?.aiAgentBudgetUsd != null ? plan.aiAgentBudgetUsd : orgUsd / 2
  return { orgUsd, agentUsd: Math.min(agentUsd, orgUsd), source: { org: o ? 'override' : plan ? 'plan' : 'default', agent: a ? 'override' : plan?.aiAgentBudgetUsd != null ? 'plan' : 'share' } }
}

/** USD spent (or reserved) this month by the organization, or by one agent. `monthStart` is YYYY-MM-01. */
export async function aiSpend(db: Db, orgId: string, agentRef: string | null, monthStart: string): Promise<number> {
  const r = await db.one<{ s: string | null }>(
    `select coalesce(sum(cost_usd), 0)::text as s from ai_usage where org_id = $1 and created_at >= $2::date and outcome <> 'refused' and ($3::text is null or agent_ref = $3)`, [orgId, monthStart, agentRef])
  return Number(r?.s ?? 0)
}

/** Staff: set (or clear, with null) a monthly budget override for an organization or one of its agents. */
export async function setBudgetOverride(db: Db, orgId: string, agentRef: string, monthlyUsd: number | null, staffLabel: string) {
  if (monthlyUsd === null) { await db.query('delete from ai_budget_overrides where org_id = $1 and agent_ref = $2', [orgId, agentRef]); return }
  if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0 || monthlyUsd > 100_000) throw new Error('monthly budget must be between 0 and 100000 USD')
  await db.query(`insert into ai_budget_overrides (org_id, agent_ref, monthly_usd, set_by) values ($1,$2,$3,$4)
    on conflict (org_id, agent_ref) do update set monthly_usd = excluded.monthly_usd, set_by = excluded.set_by, updated_at = now()`, [orgId, agentRef, monthlyUsd, staffLabel])
}
