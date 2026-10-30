/** Usage per action, for the dashboard and for billing. Each recorded action carries its estimated (or measured) tokens and cost. */
import type { Db } from '../db'
import { withActor, type Actor } from '../engine/actor'
import { LIBRARY, tierByKey, type TierKey } from './config'
import { costPerAction, tokensFor, monthlyBill, DEFAULT_MODEL } from './pricing'

export async function recordUsage(db: Db, u: { orgId: string; agentKey: string; actionType: string; actionId?: string | null; measured?: { inputTokens: number; outputTokens: number; costUsd: number } | null }) {
  const t = u.measured ? { input: u.measured.inputTokens, output: u.measured.outputTokens } : tokensFor(u.actionType)
  const cost = u.measured ? u.measured.costUsd : costPerAction(u.actionType, DEFAULT_MODEL)
  await db.query(`insert into library_usage (org_id, agent_key, action_type, action_id, input_tokens, output_tokens, cost_usd, measured) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [u.orgId, u.agentKey, u.actionType, u.actionId ?? null, t.input, t.output, cost.toFixed(6), Boolean(u.measured)])
}

export const monthStartOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))

export type UsageSummary = {
  month: string; tier: TierKey; actionsUsed: number; allowance: number; remaining: number; overageActions: number
  estimatedModelCostUsd: number; measured: boolean
  byAgent: { agentKey: string; actions: number; costUsd: number }[]
  /** what this month would cost at the proposed prices (not billed: pricing is not approved) */
  proposedBill: { base: number; overageActions: number; overage: number; total: number }
  pricingStatus: 'coming_soon' | 'published'
}

export async function usageSummary(actor: Actor, orgId: string, now = new Date()): Promise<UsageSummary> {
  return withActor(actor, async db => {
    const from = monthStartOf(now).toISOString()
    const org = await db.one<{ plan_tier: TierKey }>('select plan_tier from agencies where id = $1', [orgId])
    const tier = tierByKey(org?.plan_tier ?? 'starter') ?? LIBRARY.tiers[0]
    const rows = await db.query<{ agent_key: string; n: string; cost: string; measured: string }>(
      `select agent_key, count(*)::text as n, coalesce(sum(cost_usd), 0)::text as cost, count(*) filter (where measured)::text as measured from library_usage where org_id = $1 and at >= $2 group by agent_key order by n desc`, [orgId, from])
    const actionsUsed = rows.reduce((s, r) => s + Number(r.n), 0)
    const bill = monthlyBill(tier, actionsUsed)
    return {
      month: from.slice(0, 7), tier: tier.key, actionsUsed, allowance: tier.monthlyActions, remaining: Math.max(0, tier.monthlyActions - actionsUsed), overageActions: bill.overageActions,
      estimatedModelCostUsd: Math.round(rows.reduce((s, r) => s + Number(r.cost), 0) * 100) / 100, measured: rows.some(r => Number(r.measured) > 0),
      byAgent: rows.map(r => ({ agentKey: r.agent_key, actions: Number(r.n), costUsd: Math.round(Number(r.cost) * 100) / 100 })),
      proposedBill: bill, pricingStatus: LIBRARY.pricingStatus,
    }
  })
}
