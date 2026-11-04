/**
 * The one authorization check for anything an agent does. Every path that runs, writes or sends for an
 * agent (job handlers, store executions, email sends) calls it at the moment of acting, so a pause,
 * revoke, narrowing, expired grant or organization stop takes effect for queued work at once.
 *
 * Checks, in order (the first failure is returned):
 *   org access     the agent belongs to the organization the work is for, and still exists
 *   kill switch    the organization has not stopped all agents
 *   status         the agent is active
 *   grant          it has an active, granted authorization version
 *   capability     the tool and action are in that version (correction type and writable field, or email task and mailbox)
 *   tier           the version's permission level for the tool covers the requested level
 *   validity       a "without asking" grant has an end date that has not passed (expired grants fail closed)
 *   scope          the product or the recipients are inside the version's scope
 *   store access   for store writes: the connection is the agent's, active, and enabled for changes
 * Pure reads of the database; nothing here changes state.
 */
import type { Db } from '../db'
import { actionField, actionType, inScope, parsePolicy, permissionRank, recipientAllowed, tierOfMode, writableFields, type AgentPolicy, type Tier } from '../agents/policy'
import { writeBlockReason } from './access'
import { orgStopReason } from './kill-switch'
import type { ConnectionRow, Platform } from './types'

export type AgentAction =
  | { tool: 'run' }
  | { tool: 'store'; actionKey: string; tier: Exclude<Tier, 'draft'>; connectionId?: string; target?: { productId: string; productTags: string[] } }
  | { tool: 'email'; taskKey: string; tier: Tier; accountId?: string; recipients?: string[] }

export type AuthzCode = 'not_found' | 'wrong_org' | 'org_stopped' | 'agent_inactive' | 'no_grant' | 'capability' | 'tier' | 'expired' | 'scope' | 'store_access'
export type AuthzResult =
  | { ok: true; orgId: string; agentId: string; policyId: string; policyVersion: number; tier: Tier; policy: AgentPolicy }
  | { ok: false; code: AuthzCode; reason: string }

const TIER_RANK: Record<Tier, number> = { draft: 0, send_approved: 1, send_autonomous: 2 }
const deny = (code: AuthzCode, reason: string): AuthzResult => ({ ok: false, code, reason })

export async function authorizeAgentAction(db: Db, req: { agentId: string; orgId?: string | null; action: AgentAction; now?: Date }): Promise<AuthzResult> {
  const now = req.now ?? new Date()
  const agent = await db.one<{ id: string; org_id: string; status: string; active_policy_id: string | null; connection_id: string }>('select id, org_id, status, active_policy_id, connection_id from agents where id = $1', [req.agentId])
  if (!agent || agent.status === 'deleted') return deny('not_found', 'the agent no longer exists')
  if (req.orgId && agent.org_id !== req.orgId) return deny('wrong_org', 'the agent belongs to another organization')
  const stopped = await orgStopReason(db, agent.org_id)
  if (stopped) return deny('org_stopped', stopped)
  if (agent.status !== 'active') return deny('agent_inactive', `the agent is ${agent.status}`)
  const pr = agent.active_policy_id ? await db.one<{ id: string; version: number; status: string; policy: unknown }>('select id, version, status, policy from agent_policies where id = $1', [agent.active_policy_id]) : null
  if (!pr || pr.status !== 'active') return deny('no_grant', 'the agent has no active authorization')
  let policy: AgentPolicy
  try { policy = parsePolicy(pr.policy) } catch { return deny('no_grant', 'the agent\'s authorization could not be read') }
  const ok = (tier: Tier): AuthzResult => ({ ok: true, orgId: agent.org_id, agentId: agent.id, policyId: pr.id, policyVersion: pr.version, tier, policy })
  const a = req.action

  if (a.tool === 'run') return ok(tierOfMode(policy.approvalMode))

  if (a.tool === 'store') {
    const conn = await db.one<ConnectionRow>('select * from store_connections where id = $1', [a.connectionId ?? policy.connectionId])
    const platform: Platform = conn?.platform ?? 'shopify'
    const type = actionType(a.actionKey), field = actionField(a.actionKey)
    if (!type || !policy.correctionTypes.includes(type)) return deny('capability', 'this kind of correction is not authorized')
    if (!field || !writableFields(policy, platform).includes(field)) return deny('capability', `field "${field ?? 'unknown'}" is not writable for this agent`)
    const tier = tierOfMode(policy.approvalMode)
    if (TIER_RANK[tier] < TIER_RANK[a.tier]) return deny('tier', tier === 'draft' ? 'this agent is drafts only: it never makes changes' : 'this agent makes a change only after your approval of it')
    if (a.tier === 'send_autonomous' && (!policy.validUntil || new Date(policy.validUntil).getTime() <= now.getTime()))
      return deny('expired', policy.validUntil ? `the authorization to change the store without asking ended on ${policy.validUntil.slice(0, 10)}` : 'the authorization to change the store without asking has no end date')
    if (a.target && !inScope(policy, a.target.productId, a.target.productTags)) return deny('scope', "the product is outside the agent's scope or is an exception")
    if (!conn || conn.id !== policy.connectionId || conn.org_id !== agent.org_id) return deny('store_access', 'the store is not the one this agent is authorized for')
    if (conn.status !== 'active') return deny('store_access', `store connection is ${conn.status}`)
    const access = await writeBlockReason(db, conn)
    if (access) return deny('store_access', access)
    return ok(tier)
  }

  const e = policy.email
  if (!e) return deny('capability', 'the agent is not authorized to use email')
  if (a.accountId && a.accountId !== e.accountId) return deny('capability', 'the message is from an account this agent is not authorized to use')
  // a person's own reply from the inbox is not an agent task; every other message must be an authorized task
  if (a.taskKey !== 'human_reply' && !e.tasks.includes(a.taskKey as never)) return deny('capability', 'this email task is not authorized')
  if (permissionRank(e.permission) < TIER_RANK[a.tier]) return deny('tier', e.permission === 'draft' ? 'this agent may only create drafts' : 'this agent sends only messages you approve')
  if (a.tier === 'send_autonomous' && (!e.validUntil || new Date(e.validUntil).getTime() <= now.getTime()))
    return deny('expired', e.validUntil ? `the authorization to send without asking ended on ${e.validUntil.slice(0, 10)}` : 'sending without asking needs an end date')
  if (a.tier === 'send_autonomous' && a.recipients) {
    const outside = a.recipients.filter(r => !recipientAllowed(e, r))
    if (outside.length) return deny('scope', `recipients outside the allowed list: ${outside.join(', ')}`)
  }
  return ok(e.permission)
}
