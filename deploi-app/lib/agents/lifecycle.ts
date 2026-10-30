/**
 * Agent lifecycle. Every state change runs with the service role after the caller proved, through
 * RLS, that the actor belongs to the agent's organization (assertMerchant). Staff can read but never
 * create, grant, edit, pause, resume, revoke or delete a merchant's agent.
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { invalidateProposal, type ProposalRow } from '../engine/proposals'
import { expansionReasons, parsePolicy, policyHash, summarizePolicy, type AgentPolicy } from './policy'
import { nextRunAt } from './schedule'
import type { AgentRow, PolicyRow } from './plan'
import { randomUUID } from 'node:crypto'
import { cancelAgentEmail } from '../email/engine'
import { closeAgentMailbox, provisionMailbox } from '../email/mailbox'
import { recheckTasks } from './tasks'
import { assertWithinPlan } from '../plans/entitlements'

async function visibleConnection(actor: Actor, connectionId: string) {
  const c = await withActor(actor, db => db.one<{ id: string; org_id: string; display_name: string | null; external_id: string; status: string }>('select id, org_id, display_name, external_id, status from store_connections where id = $1', [connectionId]))
  if (!c) throw new EngineError('not_found', 'store not found')
  assertMerchant(actor, c.org_id)
  return c
}

async function visibleAgent(actor: Actor, agentId: string) {
  const a = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from agents where id = $1', [agentId]))
  if (!a) throw new EngineError('not_found', 'agent not found')
  assertMerchant(actor, a.org_id)
  return a
}

function validate(raw: unknown): AgentPolicy {
  try { return parsePolicy(raw) } catch (e) {
    const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues
    throw new EngineError('invalid_input', issues?.map(i => `${i.path.join('.') || 'policy'}: ${i.message}`).join('; ') ?? (e as Error).message)
  }
}

async function summaryFor(db: Db, p: AgentPolicy) {
  const c = await db.one<{ display_name: string | null; external_id: string }>('select display_name, external_id from store_connections where id = $1', [p.connectionId])
  const ids = [p.rules.price?.sourceId, p.rules.sku?.sourceId, p.rules.publication?.sourceId].filter((x): x is string => Boolean(x))
  const sources = ids.length ? await db.query<{ id: string; name: string; org_id: string; kind: string }>('select id, name, org_id, kind from reference_sources where id = any($1::uuid[]) and status = $2', [ids, 'active']) : []
  const acc = p.email ? await db.one<{ address: string; provider: string }>('select address, provider from email_accounts where id = $1', [p.email.accountId]) : null
  return { summary: summarizePolicy(p, { storeName: c?.display_name ?? c?.external_id ?? 'your store', sourceNames: Object.fromEntries(sources.map(s => [s.id, s.name])), emailAccount: acc }), sources }
}

/** Reference files named in the policy must exist, belong to the same org and store, and be of the right kind. An agent mailbox may be used only by its own agent. */
async function checkSources(db: Db, orgId: string, p: AgentPolicy, agentId: string) {
  const want: [string | null | undefined, string][] = [[p.rules.price?.sourceId, 'price_list'], [p.rules.sku?.sourceId, 'sku_mapping'], [p.rules.publication?.sourceId, 'publication_list']]
  for (const [id, kind] of want) {
    if (!id) continue
    const s = await db.one<{ org_id: string; connection_id: string; kind: string }>(`select org_id, connection_id, kind from reference_sources where id = $1 and status = 'active'`, [id])
    if (!s || s.org_id !== orgId || s.connection_id !== p.connectionId || s.kind !== kind) throw new EngineError('invalid_input', `the ${kind.replace('_', ' ')} chosen is not available for this store`)
  }
  if (p.email) {
    const a = await db.one<{ org_id: string; status: string; can_send: boolean; can_read: boolean; provider: string; agent_id: string | null }>('select org_id, status, can_send, can_read, provider, agent_id from email_accounts where id = $1', [p.email.accountId])
    if (!a || a.org_id !== orgId || a.status === 'disconnected') throw new EngineError('invalid_input', 'the email account chosen is not connected to this organization')
    if (a.provider === 'deploi' && a.agent_id !== agentId) throw new EngineError('invalid_input', "that address belongs to another agent; each agent sends only from its own mailbox")
    if (p.email.permission !== 'draft' && !a.can_send) throw new EngineError('invalid_input', 'the email account was connected without permission to send; reconnect it and allow sending')
    if (p.email.read.enabled && !a.can_read) throw new EngineError('invalid_input', 'reading replies needs read access to the mailbox; reconnect the account with read access first')
  }
}

/**
 * Create an agent as a draft whose first authorization waits for a grant. With `mailbox`, the agent gets
 * its own address on Deploi's domain in the same transaction, and its email settings send from it.
 */
export async function createAgent(actor: Actor, input: { name: string; taskText: string; policy: unknown; mailbox?: boolean; templateKey?: string | null }) {
  const agentId = randomUUID()
  const mailboxId = input.mailbox ? randomUUID() : null
  const raw = (input.policy && typeof input.policy === 'object' ? { ...(input.policy as Record<string, unknown>) } : input.policy) as Record<string, unknown>
  if (mailboxId) {
    if (!raw?.email || typeof raw.email !== 'object') throw new EngineError('invalid_input', 'a mailbox is only for an agent with email tasks')
    raw.email = { ...(raw.email as Record<string, unknown>), accountId: mailboxId }
  }
  const policy = validate(raw)
  const conn = await visibleConnection(actor, policy.connectionId)
  if (conn.status !== 'active') throw new EngineError('connection_inactive', 'the store is not connected')
  const name = input.name.trim()
  if (!name || name.length > 80) throw new EngineError('invalid_input', 'name must be 1 to 80 characters')
  return admin(async db => {
    await assertWithinPlan(db, conn.org_id, policy, null)
    await db.query(`insert into agents (id, org_id, connection_id, name, task_text, status, schedule, created_by) values ($1,$2,$3,$4,$5,'draft',$6,$7)`,
      [agentId, conn.org_id, conn.id, name, input.taskText.slice(0, 2000), JSON.stringify(policy.schedule), actor.label])
    const mailbox = mailboxId ? await provisionMailbox(db, { id: mailboxId, orgId: conn.org_id, agentId, agentName: name, actor: actor.label }) : null
    await checkSources(db, conn.org_id, policy, agentId)
    const { summary } = await summaryFor(db, policy)
    const pr = await db.one<{ id: string }>(`insert into agent_policies (org_id, agent_id, version, policy, policy_hash, summary, status, requires_grant, created_by) values ($1,$2,1,$3,$4,$5,'pending_grant',true,$6) returning id`,
      [conn.org_id, agentId, JSON.stringify(policy), policyHash(policy), JSON.stringify(summary), actor.label])
    await audit(db, { orgId: conn.org_id, connectionId: conn.id, entityType: 'agent', entityId: agentId, event: 'agent.created', actor: actor.label, detail: { name, policy_version: 1, policy_id: pr!.id, template: input.templateKey ?? null, mailbox: mailbox?.address ?? null } })
    return { agentId, policyId: pr!.id, policyHash: policyHash(policy), summary, mailbox: mailbox ? { id: mailbox.id, address: mailbox.address } : null }
  })
}

/**
 * Edit an agent's policy. A new version is recorded. If it grants nothing new (narrowing or neutral),
 * it takes effect at once; if it expands permissions, it waits for a fresh grant and the previous
 * version keeps running unchanged.
 */
export async function editAgent(actor: Actor, agentId: string, input: { name?: string; taskText?: string; policy: unknown }) {
  const a0 = await visibleAgent(actor, agentId)
  const policy = validate(input.policy)
  await visibleConnection(actor, policy.connectionId)
  return admin(async db => {
    const agent = (await db.one<AgentRow>('select * from agents where id = $1 for update', [agentId]))!
    if (agent.status === 'deleted') throw new EngineError('not_found', 'agent not found')
    await assertWithinPlan(db, a0.org_id, policy, agentId)
    await checkSources(db, a0.org_id, policy, agentId)
    const active = agent.active_policy_id ? await db.one<PolicyRow>(`select * from agent_policies where id = $1 and status = 'active'`, [agent.active_policy_id]) : null
    const latest = await db.one<{ v: number }>('select max(version) as v from agent_policies where agent_id = $1', [agentId])
    await db.query(`update agent_policies set status = 'discarded' where agent_id = $1 and status = 'pending_grant'`, [agentId])
    const reasons = active ? expansionReasons(parsePolicy(active.policy), policy) : ['first authorization']
    const requiresGrant = reasons.length > 0 || agent.status !== 'active'
    const { summary } = await summaryFor(db, policy)
    const version = (latest?.v ?? 0) + 1
    // only one active version at a time: retire the current one before the narrower one takes its place
    if (!requiresGrant) await db.query(`update agent_policies set status = 'superseded' where id = $1`, [active!.id])
    const pr = await db.one<{ id: string }>(`insert into agent_policies (org_id, agent_id, version, policy, policy_hash, summary, status, requires_grant, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [a0.org_id, agentId, version, JSON.stringify(policy), policyHash(policy), JSON.stringify(summary), requiresGrant ? 'pending_grant' : 'active', requiresGrant, actor.label])
    if (input.name !== undefined || input.taskText !== undefined) await db.query('update agents set name = coalesce($2, name), task_text = coalesce($3, task_text) where id = $1', [agentId, input.name?.trim().slice(0, 80) || null, input.taskText?.slice(0, 2000) ?? null])
    if (!requiresGrant) {
      await db.query('update agents set active_policy_id = $2, schedule = $3, next_run_at = $4 where id = $1', [agentId, pr!.id, JSON.stringify(policy.schedule), nextRunAt(policy.schedule, new Date())?.toISOString() ?? null])
      await retireAgentProposals(db, agentId, 'stale', 'the agent\'s authorization was narrowed; changes will be recomputed', actor.label)
    }
    await audit(db, { orgId: a0.org_id, entityType: 'policy', entityId: pr!.id, event: requiresGrant ? 'policy.awaiting_grant' : 'policy.applied_without_grant', actor: actor.label, detail: { agent_id: agentId, version, expansion: reasons } })
    return { policyId: pr!.id, version, requiresGrant, expansion: reasons, policyHash: policyHash(policy), summary }
  })
}

export type OverlapCheck = { conflicts: string[]; warnings: string[] }

/** Two active agents correcting the same thing on the same products would fight; refuse certain overlaps, warn on possible ones. */
export function overlap(a: AgentPolicy, b: AgentPolicy, bName: string): OverlapCheck {
  const out: OverlapCheck = { conflicts: [], warnings: [] }
  if (a.connectionId !== b.connectionId) return out
  // drafts-only agents never write, so they cannot fight over a record
  if (a.approvalMode === 'draft' || b.approvalMode === 'draft') return out
  const shared = a.correctionTypes.filter(t => b.correctionTypes.includes(t))
  if (!shared.length) return out
  const sa = a.productScope, sb = b.productScope
  const certain = sa.mode === 'all' || sb.mode === 'all'
    || (sa.mode === 'products' && sb.mode === 'products' && sa.productIds.some(id => sb.productIds.includes(id)))
    || (sa.mode === 'tags' && sb.mode === 'tags' && sa.tags.some(t => sb.tags.includes(t)))
  const msg = `"${bName}" already corrects ${shared.join(', ')} on overlapping products`
  if (certain) out.conflicts.push(msg)
  else if (!(sa.mode === 'products' && sb.mode === 'products')) out.warnings.push(`"${bName}" also corrects ${shared.join(', ')}; products carrying both scopes' tags would be covered twice (the engine refuses to run conflicting changes)`)
  return out
}

/** Grant the exact policy version the merchant reviewed (bound by its hash). Activates the agent. */
export async function grantPolicy(actor: Actor, agentId: string, policyId: string, shownHash: string) {
  const a0 = await visibleAgent(actor, agentId)
  return admin(async db => {
    const agent = (await db.one<AgentRow>('select * from agents where id = $1 for update', [agentId]))!
    if (agent.status === 'deleted') throw new EngineError('not_found', 'agent not found')
    const pr = await db.one<PolicyRow>('select * from agent_policies where id = $1 and agent_id = $2 for update', [policyId, agentId])
    if (!pr || pr.status !== 'pending_grant') throw new EngineError('not_pending', 'this version is not waiting for a grant')
    if (pr.policy_hash !== shownHash) throw new EngineError('hash_mismatch', 'the authorization you reviewed is not the current version; review it again')
    const policy = parsePolicy(pr.policy)
    await checkSources(db, a0.org_id, policy, agentId)
    const others = await db.query<{ name: string; policy: AgentPolicy }>(
      `select a.name, p.policy from agents a join agent_policies p on p.id = a.active_policy_id where a.connection_id = $1 and a.status in ('active','paused') and a.id <> $2`, [agent.connection_id, agentId])
    const checks = others.map(o => overlap(policy, parsePolicy(o.policy), o.name))
    const conflicts = checks.flatMap(c => c.conflicts), warnings = checks.flatMap(c => c.warnings)
    if (conflicts.length) throw new EngineError('invalid_input', `cannot grant: ${conflicts.join('; ')}. Narrow this agent's scope or pause the other agent.`)
    if (agent.active_policy_id) await db.query(`update agent_policies set status = 'superseded' where id = $1 and status = 'active'`, [agent.active_policy_id])
    await db.query(`update agent_policies set status = 'active', granted_by = $2, granted_at = now() where id = $1`, [pr.id, actor.label])
    const next = nextRunAt(policy.schedule, new Date())
    await db.query(`update agents set status = 'active', active_policy_id = $2, schedule = $3, next_run_at = $4 where id = $1`, [agentId, pr.id, JSON.stringify(policy.schedule), next?.toISOString() ?? null])
    if (agent.active_policy_id) await retireAgentProposals(db, agentId, 'stale', 'the agent\'s authorization changed; changes will be recomputed', actor.label)
    // plain-language tasks that waited for wider rules run once the new grant covers them
    const tasksQueued = await recheckTasks(db, agentId, actor.label)
    await audit(db, { orgId: a0.org_id, entityType: 'policy', entityId: pr.id, event: 'policy.granted', actor: actor.label, detail: { agent_id: agentId, version: pr.version, policy_hash: pr.policy_hash, approval_mode: policy.approvalMode, warnings, tasks_queued: tasksQueued } })
    return { version: pr.version, warnings, nextRunAt: next?.toISOString() ?? null, tasksQueued }
  })
}

async function retireAgentProposals(db: Db, agentId: string, status: 'stale' | 'blocked', reason: string, actor: string) {
  const live = await db.query<ProposalRow>(`select * from proposals where agent_id = $1 and status in ('pending_approval','approved')`, [agentId])
  for (const p of live) await invalidateProposal(db, p, status, reason, actor)
  // queued writes never start: the execution is closed as blocked before any request is sent
  await db.query(`update executions set status = 'blocked', status_reason = $2, finished_at = now() where agent_id = $1 and status = 'queued'`, [agentId, reason])
  return live.length
}

/** Pause: no runs and no writes, including changes already approved and queued. Authorization is kept. */
export async function pauseAgent(actor: Actor, agentId: string) {
  const a0 = await visibleAgent(actor, agentId)
  return admin(async db => {
    const r = await db.query(`update agents set status = 'paused', next_run_at = null where id = $1 and status = 'active' returning id`, [agentId])
    if (!r.length) throw new EngineError('not_pending', 'only an active agent can be paused')
    const n = await retireAgentProposals(db, agentId, 'blocked', 'the agent was paused', actor.label)
    const m = await cancelAgentEmail(db, agentId, 'the agent was paused; queued messages are not sent', false)
    await audit(db, { orgId: a0.org_id, entityType: 'agent', entityId: agentId, event: 'agent.paused', actor: actor.label, detail: { proposals_blocked: n, emails_cancelled: m } })
    return { proposalsBlocked: n, emailsCancelled: m }
  })
}

export async function resumeAgent(actor: Actor, agentId: string) {
  const a0 = await visibleAgent(actor, agentId)
  return admin(async db => {
    const agent = await db.one<AgentRow>('select * from agents where id = $1 for update', [agentId])
    if (!agent || agent.status !== 'paused' || !agent.active_policy_id) throw new EngineError('not_pending', 'only a paused agent with an active authorization can resume')
    const next = nextRunAt(agent.schedule, new Date())
    await db.query(`update agents set status = 'active', next_run_at = $2 where id = $1`, [agentId, next?.toISOString() ?? null])
    await audit(db, { orgId: a0.org_id, entityType: 'agent', entityId: agentId, event: 'agent.resumed', actor: actor.label })
  })
}

/** Revoke: the authorization ends; nothing more is written, queued changes are cancelled. The agent stays for its history and can be re-authorized. */
export async function revokeAgent(actor: Actor, agentId: string, reason = 'revoked by the merchant') {
  const a0 = await visibleAgent(actor, agentId)
  return admin(async db => revokeInTx(db, a0.org_id, agentId, actor.label, reason, 'revoked'))
}

async function revokeInTx(db: Db, orgId: string, agentId: string, actor: string, reason: string, status: 'revoked' | 'deleted') {
  await db.query(`update agent_policies set status = 'revoked', revoked_by = $2, revoked_at = now(), revoke_reason = $3 where agent_id = $1 and status in ('active','pending_grant')`, [agentId, actor, reason])
  await db.query(`update agents set status = $2, active_policy_id = null, next_run_at = null where id = $1`, [agentId, status])
  const n = await retireAgentProposals(db, agentId, 'blocked', status === 'deleted' ? 'the agent was deleted' : 'the agent\'s authorization was revoked', actor)
  const m = await cancelAgentEmail(db, agentId, status === 'deleted' ? 'the agent was deleted' : 'the agent\'s authorization was revoked', true)
  const closed = status === 'deleted' ? await closeAgentMailbox(db, agentId, actor) : 0
  // plain-language tasks that have not run are cancelled with the agent
  await db.query(`update agent_tasks set status = 'cancelled', status_reason = $2, finished_at = now() where agent_id = $1 and status in ('needs_approval','queued')`, [agentId, status === 'deleted' ? 'the agent was deleted' : "the agent's authorization was revoked"])
  await audit(db, { orgId, entityType: 'agent', entityId: agentId, event: `agent.${status}`, actor, detail: { reason, proposals_blocked: n, emails_cancelled: m, mailbox_closed: closed > 0 } })
  return { proposalsBlocked: n, emailsCancelled: m }
}

/** Delete: revoke and hide. History (issues, executions, audit) is kept for the record. */
export async function deleteAgent(actor: Actor, agentId: string) {
  const a0 = await visibleAgent(actor, agentId)
  return admin(async db => {
    const r = await revokeInTx(db, a0.org_id, agentId, actor.label, 'agent deleted', 'deleted')
    // what it recorded about other stores goes with it (the audit trail keeps what was done)
    await db.query('delete from competitor_findings where agent_id = $1', [agentId])
    await db.query('delete from competitor_sources where agent_id = $1', [agentId])
    return r
  })
}
