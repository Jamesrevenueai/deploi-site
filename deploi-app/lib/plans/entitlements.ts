/**
 * Plan entitlements and usage safeguards. The proposed launch configuration is a free beta (pending the
 * owner's approval of any paid plan); no price is charged and no billing is implemented here. Limits are
 * configurable per environment and enforced on the server when an agent is created or widened.
 *
 *   PLAN_KEY                       beta_free (default)
 *   PLAN_MAX_AGENTS                agents per organization that are not deleted (default 10)
 *   PLAN_MAX_COMPETITOR_STORES     competitor stores watched across the organization (default 25)
 *   PLAN_MAX_COMPETITOR_REQUESTS   requests per store per check (caps the policy budget, default 20)
 */
import type { Db } from '../db'
import { EngineError } from '../engine/errors'
import type { AgentPolicy } from '../agents/policy'

const num = (k: string, d: number) => { const v = Number((process.env[k] ?? '').trim()); return Number.isInteger(v) && v > 0 ? v : d }

export type Entitlements = { plan: string; label: string; priced: false; maxAgents: number; maxCompetitorStores: number; maxCompetitorRequests: number }

export function entitlements(): Entitlements {
  return {
    plan: (process.env.PLAN_KEY ?? '').trim() || 'beta_free', label: 'Free beta', priced: false,
    maxAgents: num('PLAN_MAX_AGENTS', 10), maxCompetitorStores: num('PLAN_MAX_COMPETITOR_STORES', 25), maxCompetitorRequests: num('PLAN_MAX_COMPETITOR_REQUESTS', 20),
  }
}

/** Throws when creating (agentId null) or widening this agent would exceed the plan. */
export async function assertWithinPlan(db: Db, orgId: string, policy: AgentPolicy, agentId: string | null) {
  const e = entitlements()
  if (!agentId) {
    const n = await db.one<{ n: string }>(`select count(*)::text as n from agents where org_id = $1 and status <> 'deleted'`, [orgId])
    if (Number(n?.n ?? 0) >= e.maxAgents) throw new EngineError('invalid_input', `the ${e.label} allows ${e.maxAgents} agents; delete one first`)
  }
  if (policy.competitor) {
    if (policy.competitor.budget.maxRequestsPerStore > e.maxCompetitorRequests) throw new EngineError('invalid_input', `the ${e.label} allows at most ${e.maxCompetitorRequests} requests per store per check`)
    const others = await db.one<{ n: string }>(
      `select coalesce(sum(jsonb_array_length(p.policy->'competitor'->'stores')), 0)::text as n from agents a join agent_policies p on p.id = a.active_policy_id
       where a.org_id = $1 and a.status in ('active','paused','draft') and ($2::uuid is null or a.id <> $2) and p.policy ? 'competitor'`, [orgId, agentId])
    const total = Number(others?.n ?? 0) + policy.competitor.stores.length
    if (total > e.maxCompetitorStores) throw new EngineError('invalid_input', `the ${e.label} allows ${e.maxCompetitorStores} watched competitor stores in total (this would make ${total})`)
  }
}
