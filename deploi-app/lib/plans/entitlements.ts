/**
 * Plan entitlements and usage safeguards. The proposed launch configuration is a free beta (pending the
 * owner's approval of any paid plan); no price is charged and no billing is implemented here. Limits are
 * configurable per environment and enforced on the server when an agent is created or widened.
 *
 *   PLAN_KEY                       beta_free (default)
 *   PLAN_MAX_AGENTS                agents per organization that are not deleted (default 10)
 *   PLAN_MAX_COMPETITOR_STORES     competitor stores watched across the organization (default 25)
 */
import type { Db } from '../db'
import { EngineError } from '../engine/errors'
import type { AgentPolicy } from '../agents/policy'

const num = (k: string, d: number) => { const v = Number((process.env[k] ?? '').trim()); return Number.isInteger(v) && v > 0 ? v : d }

export type Entitlements = { plan: string; label: string; priced: false; maxAgents: number; maxCompetitorStores: number }

export function entitlements(): Entitlements {
  return {
    plan: (process.env.PLAN_KEY ?? '').trim() || 'beta_free', label: 'Free beta', priced: false,
    maxAgents: num('PLAN_MAX_AGENTS', 10), maxCompetitorStores: num('PLAN_MAX_COMPETITOR_STORES', 25),
  }
}

/** Throws when creating (agentId null) or widening this agent would exceed the plan. */
export async function assertWithinPlan(db: Db, orgId: string, policy: AgentPolicy, agentId: string | null) {
  const e = entitlements()
  if (!agentId) {
    const n = await db.one<{ n: string }>(`select count(*)::text as n from agents where org_id = $1 and status <> 'deleted'`, [orgId])
    if (Number(n?.n ?? 0) >= e.maxAgents) throw new EngineError('invalid_input', `the ${e.label} allows ${e.maxAgents} agents; delete one first`)
  }
  if (policy.competitors) {
    // each agent's latest policy version counts, authorized or not: a draft is a store list waiting to be granted
    const others = await db.one<{ n: string }>(
      `select coalesce(sum(jsonb_array_length(p.policy->'competitors'->'stores')), 0)::text as n from agents a
       join lateral (select policy from agent_policies where agent_id = a.id order by version desc limit 1) p on true
       where a.org_id = $1 and a.status in ('active','paused','draft') and ($2::uuid is null or a.id <> $2) and p.policy ? 'competitors'`, [orgId, agentId])
    const total = Number(others?.n ?? 0) + policy.competitors.stores.length
    if (total > e.maxCompetitorStores) throw new EngineError('invalid_input', `the ${e.label} allows ${e.maxCompetitorStores} watched competitor stores in total (this would make ${total})`)
  }
}
