/** Agent -> scan plan, plus the qualification rules for standing authorization. */
import type { Db } from '../db'
import { getCheck } from '../engine/registry'
import type { ScanPlan, PlannedCheck } from '../engine/plan'
import type { ResourceRecord } from '../engine/types'
import { loadReference, moneyCents, type ReferenceIndex } from './references'
import { ACTION_FIELD, ACTION_TYPE, CORRECTION_CHECK, CORRECTION_TYPES, inScope, parsePolicy, writableFields, type AgentPolicy } from './policy'

export type AgentRow = { id: string; org_id: string; connection_id: string; name: string; task_text: string; status: 'draft' | 'active' | 'paused' | 'revoked' | 'deleted'; active_policy_id: string | null; schedule: AgentPolicy['schedule']; next_run_at: string | null; last_run_at: string | null; created_by: string; created_at: string; updated_at: string }
export type PolicyRow = { id: string; org_id: string; agent_id: string; version: number; policy: AgentPolicy; policy_hash: string; summary: unknown; status: 'pending_grant' | 'active' | 'superseded' | 'revoked' | 'discarded'; requires_grant: boolean; created_by: string; created_at: string; granted_by: string | null; granted_at: string | null; revoked_at: string | null; revoke_reason: string | null }

export type AgentContext = { agent: AgentRow; policyRow: PolicyRow; policy: AgentPolicy; plan: ScanPlan }

export const ALL_AGENT_CHECKS = CORRECTION_TYPES.map(t => CORRECTION_CHECK[t])

/** The agent's active, granted policy as a scan plan. Null when the agent may not act (no active grant). */
export async function loadAgentContext(db: Db, agentId: string): Promise<AgentContext | null> {
  const agent = await db.one<AgentRow>('select * from agents where id = $1', [agentId])
  if (!agent || !agent.active_policy_id) return null
  const policyRow = await db.one<PolicyRow>(`select * from agent_policies where id = $1 and status = 'active'`, [agent.active_policy_id])
  if (!policyRow) return null
  const policy = parsePolicy(policyRow.policy)
  const conn = await db.one<{ currency: string | null }>('select currency from store_connections where id = $1', [agent.connection_id])
  const references: Record<string, ReferenceIndex> = {}
  for (const id of [policy.rules.price?.sourceId, policy.rules.sku?.sourceId, policy.rules.publication?.sourceId].filter((x): x is string => Boolean(x))) {
    const r = await loadReference(db, id)
    if (r) references[id] = r
  }
  const checks: PlannedCheck[] = []
  for (const t of policy.correctionTypes) {
    const check = getCheck(CORRECTION_CHECK[t])
    if (!check) continue
    const config = t === 'oversell_policy' ? { ...policy.rules.oversell_policy, exemptProductIds: [] } : (policy.rules[t] as Record<string, unknown>)
    checks.push({ check, config: check.parseConfig(config), version: policyRow.version })
  }
  const plan: ScanPlan = {
    agentId: agent.id, policyId: policyRow.id, policyVersion: policyRow.version, checks,
    scope: (r: ResourceRecord) => inScope(policy, String(r.productId ?? ''), Array.isArray(r.productTags) ? (r.productTags as string[]) : []),
    references, currency: conn?.currency ?? null, ownedCheckKeys: ALL_AGENT_CHECKS,
  }
  return { agent, policyRow, policy, plan }
}

export type Qualification = { covered: boolean; reasons: string[]; blockers: string[] }

/**
 * Does the agent's standing authorization cover this exact change on this fresh record?
 * `counts` are changes already made under standing authorization (this run, today).
 */
export function qualifies(ctx: AgentContext, input: { actionKey: string; change: { field: string; from: unknown; to: unknown; params?: Record<string, unknown> }; record: ResourceRecord; counts: { run: number | null; day: number } }): Qualification {
  const { policy, agent, policyRow } = ctx
  const reasons: string[] = [], blockers: string[] = []
  if (agent.status !== 'active') blockers.push(`agent is ${agent.status}`)
  if (policyRow.status !== 'active') blockers.push('authorization is not active')
  if (policy.approvalMode !== 'autonomous') blockers.push('agent is in review mode: each change needs approval')
  const type = ACTION_TYPE[input.actionKey]
  if (!type || !policy.correctionTypes.includes(type)) blockers.push('this kind of correction is not authorized'); else reasons.push(`correction type "${type}" is authorized`)
  const field = ACTION_FIELD[input.actionKey]
  if (!field || !writableFields(policy).includes(field)) blockers.push(`field "${field ?? 'unknown'}" is not writable for this agent`); else reasons.push(`field "${field}" is writable`)
  const pid = String(input.record.productId ?? '')
  if (!inScope(policy, pid, Array.isArray(input.record.productTags) ? (input.record.productTags as string[]) : [])) blockers.push('the product is outside the agent\'s scope or is an exception'); else reasons.push('the product is inside the agent\'s scope')
  if (input.actionKey === 'shopify.product.unpublish' && !policy.rules.publication?.allowUnpublish) blockers.push('unpublishing is not authorized')
  if (input.actionKey === 'shopify.variant.set_sku' && input.change.from && !policy.rules.sku?.allowOverwrite) blockers.push('overwriting an existing SKU is not authorized')
  if (type === 'price' && policy.rules.price) {
    const before = moneyCents(String(input.change.from ?? '')), after = moneyCents(String(input.change.to ?? ''))
    const max = policy.rules.price.maxChangePct
    if (before !== null && after !== null && before > 0 && max !== null) {
      const pct = Math.abs(after - before) / before * 100
      if (pct > max + 1e-9) blockers.push(`price change of ${pct.toFixed(1)}% exceeds the ${max}% limit`); else reasons.push(`price change of ${pct.toFixed(1)}% is within the ${max}% limit`)
    } else if (before === 0 && max !== null) blockers.push('current price is zero; percentage limit cannot be applied')
  }
  if (input.counts.run !== null && input.counts.run >= policy.limits.maxChangesPerRun) blockers.push(`run limit of ${policy.limits.maxChangesPerRun} changes reached`)
  if (input.counts.day >= policy.limits.maxChangesPerDay) blockers.push(`daily limit of ${policy.limits.maxChangesPerDay} changes reached`)
  if (!blockers.length) reasons.push(`within limits (${input.counts.run ?? 'n/a'}/${policy.limits.maxChangesPerRun} this run, ${input.counts.day}/${policy.limits.maxChangesPerDay} today)`, `authorization version ${policyRow.version}`)
  return { covered: blockers.length === 0, reasons, blockers }
}

export function plannedCheckFor(ctx: AgentContext, checkKey: string): PlannedCheck | undefined { return ctx.plan.checks.find(c => c.check.key === checkKey) }
