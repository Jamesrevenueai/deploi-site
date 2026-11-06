/**
 * Office agent lifecycle, mirroring store agents (lib/agents/lifecycle.ts): every state change runs with
 * the service role after the caller was shown, through RLS, to belong to the agent's organization.
 * Staff can read but never create, grant, edit, pause, resume, revoke or delete. A new agent is a draft
 * whose first policy version waits for a grant; widening is a new version that must be granted again.
 */
import { admin, type Db } from '../db'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { orgStopReason } from '../engine/kill-switch'
import { assertProduct } from '../products'
import { assertOfficeSeat } from '../plans/entitlements'
import { officeAudit } from './audit'
import { cancelAgentActions, type AgentRow } from './actions'
import { officeExpansion, officePolicyHash, parseOfficePolicy, summarizeOfficePolicy, type OfficeKind, type OfficePolicy } from './policy'
import { assertCan } from '../platform/rbac'

type PolicyRow = { id: string; agent_id: string; version: number; policy: unknown; policy_hash: string; status: string }

function validate(raw: unknown): OfficePolicy {
  try { return parseOfficePolicy(raw) } catch (e) {
    const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues
    throw new EngineError('invalid_input', issues?.map(i => `${i.path.join('.') || 'policy'}: ${i.message}`).join('; ') ?? (e as Error).message)
  }
}

function merchant(actor: Actor): asserts actor is Exclude<Actor, { kind: 'staff' }> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff can view but not change a customer\'s agents')
}

async function visibleAgent(actor: Actor, agentId: string) {
  const a = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from office_agents where id = $1', [agentId]))
  if (!a) throw new EngineError('not_found', 'agent not found')
  assertMerchant(actor, a.org_id)
  return a
}

/**
 * The connections and mailbox a policy names must belong to the organization and be usable. Synthetic
 * (test) resources and real ones are never combined in one agent.
 */
export async function checkResources(db: Db, orgId: string, p: OfficePolicy) {
  const flags: boolean[] = []
  const conn = async (id: string | null, provider: 'hubspot' | 'google_calendar' | 'quickbooks', label: string) => {
    if (!id) return null
    const c = await db.one<{ org_id: string; provider: string; status: string; is_synthetic: boolean; display_name: string | null; external_account_id: string }>('select * from office_connections where id = $1', [id])
    if (!c || c.org_id !== orgId || c.provider !== provider || c.status === 'disconnected') throw new EngineError('invalid_input', `the ${label} chosen is not connected to this organization`)
    flags.push(c.is_synthetic)
    return c.display_name ?? c.external_account_id
  }
  const hubspot = await conn(p.hubspotConnectionId, 'hubspot', 'HubSpot account')
  const calendar = await conn(p.calendarConnectionId, 'google_calendar', 'calendar')
  const quickbooks = await conn(p.quickbooksConnectionId, 'quickbooks', 'QuickBooks company')
  let mailbox: string | null = null
  if (p.mailboxAccountId) {
    const a = await db.one<{ org_id: string; status: string; can_send: boolean; provider: string; is_synthetic: boolean; office_mailbox: boolean; address: string }>('select * from email_accounts where id = $1', [p.mailboxAccountId])
    if (!a || a.org_id !== orgId || a.status === 'disconnected') throw new EngineError('invalid_input', 'the mailbox chosen is not connected to this organization')
    if (a.provider === 'deploi' && !a.office_mailbox) throw new EngineError('invalid_input', "that address belongs to a store agent; use the organization's office mailbox or a connected account")
    if (p.email && p.email.tier !== 'draft' && !a.can_send) throw new EngineError('invalid_input', 'the mailbox was connected without permission to send; reconnect it and allow sending')
    flags.push(a.is_synthetic)
    mailbox = a.address
  }
  if (flags.length && flags.some(f => f !== flags[0])) throw new EngineError('invalid_input', 'a synthetic (test) connection cannot be combined with a real account in one agent')
  return { hubspot, calendar, mailbox, quickbooks }
}

export async function createOfficeAgent(actor: Actor, input: { kind: OfficeKind; name: string; policy: unknown }) {
  merchant(actor)
  assertMerchant(actor, actor.orgId)
  const policy = validate(input.policy)
  if (policy.kind !== input.kind) throw new EngineError('invalid_input', 'the policy is for a different kind of agent')
  const name = input.name.trim()
  if (!name || name.length > 80) throw new EngineError('invalid_input', 'name must be 1 to 80 characters')
  return admin(async db => {
    await assertProduct(db, actor.orgId, 'office')
    await assertOfficeSeat(db, actor.orgId) // the plan's Office seats (only while billing is on)
    const ctx = await checkResources(db, actor.orgId, policy)
    const agent = (await db.one<{ id: string }>(`insert into office_agents (org_id, kind, name, status, created_by) values ($1,$2,$3,'draft',$4) returning id`, [actor.orgId, input.kind, name, actor.label]))!
    const summary = summarizeOfficePolicy(policy, ctx)
    const pr = (await db.one<{ id: string }>(`insert into office_agent_policies (org_id, agent_id, version, policy, policy_hash, summary, status, requires_grant, expansion, created_by) values ($1,$2,1,$3,$4,$5,'pending_grant',true,'["first authorization"]',$6) returning id`,
      [actor.orgId, agent.id, JSON.stringify(policy), officePolicyHash(policy), JSON.stringify(summary), actor.label]))!
    await officeAudit(db, { orgId: actor.orgId, entityType: 'office_agent', entityId: agent.id, event: 'agent.created', actor: actor.label, detail: { kind: input.kind, name, policy_version: 1, policy_id: pr.id } })
    return { agentId: agent.id, policyId: pr.id, policyHash: officePolicyHash(policy), summary }
  })
}

/** Edit the policy: a new version. Narrowing or neutral changes apply at once; anything wider waits for a grant while the old version keeps running. */
export async function editOfficeAgent(actor: Actor, agentId: string, input: { name?: string; policy: unknown }) {
  merchant(actor)
  const a0 = await visibleAgent(actor, agentId)
  const policy = validate(input.policy)
  return admin(async db => {
    await assertProduct(db, a0.org_id, 'office')
    const agent = (await db.one<AgentRow>('select * from office_agents where id = $1 for update', [agentId]))!
    if (agent.status === 'deleted') throw new EngineError('not_found', 'agent not found')
    if (policy.kind !== agent.kind) throw new EngineError('invalid_input', 'an agent cannot change its kind')
    const ctx = await checkResources(db, a0.org_id, policy)
    const active = agent.active_policy_id ? await db.one<PolicyRow>(`select * from office_agent_policies where id = $1 and status = 'active'`, [agent.active_policy_id]) : null
    const latest = await db.one<{ v: number }>('select max(version) as v from office_agent_policies where agent_id = $1', [agentId])
    await db.query(`update office_agent_policies set status = 'discarded' where agent_id = $1 and status = 'pending_grant'`, [agentId])
    const reasons = active ? officeExpansion(parseOfficePolicy(active.policy), policy) : ['first authorization']
    const requiresGrant = reasons.length > 0 || agent.status !== 'active'
    const version = (latest?.v ?? 0) + 1
    if (!requiresGrant) await db.query(`update office_agent_policies set status = 'superseded' where id = $1`, [active!.id])
    const pr = (await db.one<{ id: string }>(`insert into office_agent_policies (org_id, agent_id, version, policy, policy_hash, summary, status, requires_grant, expansion, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [a0.org_id, agentId, version, JSON.stringify(policy), officePolicyHash(policy), JSON.stringify(summarizeOfficePolicy(policy, ctx)), requiresGrant ? 'pending_grant' : 'active', requiresGrant, JSON.stringify(reasons), actor.label]))!
    if (input.name?.trim()) await db.query('update office_agents set name = $2 where id = $1', [agentId, input.name.trim().slice(0, 80)])
    if (!requiresGrant) await db.query('update office_agents set active_policy_id = $2 where id = $1', [agentId, pr.id])
    await officeAudit(db, { orgId: a0.org_id, entityType: 'office_policy', entityId: pr.id, event: requiresGrant ? 'policy.awaiting_grant' : 'policy.applied_without_grant', actor: actor.label, detail: { agent_id: agentId, version, expansion: reasons } })
    return { policyId: pr.id, version, requiresGrant, expansion: reasons, policyHash: officePolicyHash(policy) }
  })
}

/** Grant the exact version the customer reviewed (bound by its hash). Activates the agent. */
export async function grantOfficePolicy(actor: Actor, agentId: string, policyId: string, shownHash: string, opts: { now?: Date } = {}) {
  merchant(actor)
  const a0 = await visibleAgent(actor, agentId)
  await assertCan(actor, a0.org_id, 'agent.grant') // F-08: owners and admins only
  return admin(async db => {
    await assertProduct(db, a0.org_id, 'office')
    const agent = (await db.one<AgentRow>('select * from office_agents where id = $1 for update', [agentId]))!
    if (agent.status === 'deleted') throw new EngineError('not_found', 'agent not found')
    const stopped = await orgStopReason(db, a0.org_id)
    if (stopped) throw new EngineError('agent_inactive', `${stopped}; turn the stop off before granting an agent`)
    const pr = await db.one<PolicyRow>('select * from office_agent_policies where id = $1 and agent_id = $2 for update', [policyId, agentId])
    if (!pr || pr.status !== 'pending_grant') throw new EngineError('not_pending', 'this version is not waiting for a grant')
    if (pr.policy_hash !== shownHash) throw new EngineError('hash_mismatch', 'the authorization you reviewed is not the current version; review it again')
    if (agent.status !== 'active') await assertOfficeSeat(db, a0.org_id, agentId)
    const policy = parseOfficePolicy(pr.policy)
    await checkResources(db, a0.org_id, policy)
    if (agent.active_policy_id) await db.query(`update office_agent_policies set status = 'superseded' where id = $1 and status = 'active'`, [agent.active_policy_id])
    await db.query(`update office_agent_policies set status = 'active', granted_by = $2, granted_at = now() where id = $1`, [pr.id, actor.label])
    const next = new Date((opts.now ?? new Date()).getTime() + 60e3)
    await db.query(`update office_agents set status = 'active', active_policy_id = $2, next_run_at = $3 where id = $1`, [agentId, pr.id, next.toISOString()])
    await officeAudit(db, { orgId: a0.org_id, entityType: 'office_policy', entityId: pr.id, event: 'policy.granted', actor: actor.label, detail: { agent_id: agentId, version: pr.version, policy_hash: pr.policy_hash, tiers: { email: policy.email?.tier ?? null, calendar: policy.calendar?.tier ?? null, crm: policy.crm?.tier ?? null } } })
    return { version: pr.version }
  })
}

/** Pause: no runs, nothing sent or written, including items already approved and queued. The authorization is kept. */
export async function pauseOfficeAgent(actor: Actor, agentId: string) {
  merchant(actor)
  const a0 = await visibleAgent(actor, agentId)
  return admin(async db => {
    const r = await pauseOfficeAgentInTx(db, a0.org_id, agentId, actor.label)
    if (!r) throw new EngineError('not_pending', 'only an active agent can be paused')
    return r
  })
}

/** Pause inside the caller's transaction (also used by plan enforcement). Null when the agent was not active. */
export async function pauseOfficeAgentInTx(db: Db, orgId: string, agentId: string, actor: string, reason?: string) {
  const r = await db.query(`update office_agents set status = 'paused', next_run_at = null where id = $1 and org_id = $2 and status = 'active' returning id`, [agentId, orgId])
  if (!r.length) return null
  const n = await cancelAgentActions(db, agentId, `${reason ?? 'the agent was paused'}; queued items are not carried out`, false)
  await officeAudit(db, { orgId, entityType: 'office_agent', entityId: agentId, event: 'agent.paused', actor, detail: { actions_cancelled: n.actions, emails_cancelled: n.emails, ...(reason ? { reason } : {}) } })
  return { actionsCancelled: n.actions, emailsCancelled: n.emails }
}

export async function resumeOfficeAgent(actor: Actor, agentId: string) {
  merchant(actor)
  const a0 = await visibleAgent(actor, agentId)
  await assertCan(actor, a0.org_id, 'agent.grant')
  return admin(async db => {
    await assertProduct(db, a0.org_id, 'office')
    const stopped = await orgStopReason(db, a0.org_id)
    if (stopped) throw new EngineError('agent_inactive', `${stopped}; turn the stop off before resuming an agent`)
    await assertOfficeSeat(db, a0.org_id, agentId)
    const r = await db.query(`update office_agents set status = 'active', next_run_at = now() where id = $1 and status = 'paused' and active_policy_id is not null returning id`, [agentId])
    if (!r.length) throw new EngineError('not_pending', 'only a paused agent with an active authorization can resume')
    await officeAudit(db, { orgId: a0.org_id, entityType: 'office_agent', entityId: agentId, event: 'agent.resumed', actor: actor.label })
  })
}

/** Revoke (or delete): the authorization ends at once; drafts, approvals and queued items are cancelled. */
export async function revokeOfficeAgent(actor: Actor, agentId: string, opts: { delete?: boolean } = {}) {
  merchant(actor)
  const a0 = await visibleAgent(actor, agentId)
  const status = opts.delete ? 'deleted' : 'revoked'
  return admin(async db => {
    await db.query('select id from office_agents where id = $1 for update', [agentId])
    await db.query(`update office_agent_policies set status = 'revoked', revoked_by = $2, revoked_at = now(), revoke_reason = $3 where agent_id = $1 and status in ('active','pending_grant')`, [agentId, actor.label, `${status} by the customer`])
    await db.query(`update office_agents set status = $2, active_policy_id = null, next_run_at = null where id = $1`, [agentId, status])
    const n = await cancelAgentActions(db, agentId, status === 'deleted' ? 'the agent was deleted' : "the agent's authorization was revoked", true)
    await db.query(`update office_leads set status = 'stopped', stop_reason = $2, next_touch_at = null where agent_id = $1 and status = 'active'`, [agentId, `the agent was ${status}`])
    await officeAudit(db, { orgId: a0.org_id, entityType: 'office_agent', entityId: agentId, event: `agent.${status}`, actor: actor.label, detail: { actions_cancelled: n.actions, emails_cancelled: n.emails } })
    return { actionsCancelled: n.actions, emailsCancelled: n.emails }
  })
}
