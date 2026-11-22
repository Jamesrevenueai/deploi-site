/**
 * Office approvals. These two functions are the integration point for the unified approvals inbox:
 *   listOfficePendingApprovals(db, orgId)          everything waiting for a person, with the exact content
 *   decideOfficeAction(db, actor, actionId, d)     approve or reject one exact item
 * `db` must be a service-role connection (admin()): the exact email text and event details are not
 * readable by user sessions. decideOfficeAction checks the actor itself (a member of the action's
 * organization; staff can never decide). Approving only queues the item: call executeOfficeAction(id)
 * after the transaction commits (approveOfficeAction does both).
 */
import { admin, type Db } from '../db'
import { assertMerchant, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { officeAudit } from './audit'
import { actionSettled, agentCtx, executeOfficeAction, payloadHash, type ActionPayload, type OfficeActionRow } from './actions'
// registers the case hooks (Office actions move their Resolution Engine case)
import './resolution'
import { tierRank, TOOL_OF } from './policy'
import { assertCan } from '../platform/rbac'
import { needsFirstReplyApproval, trustSender } from '../email/sender-policy'

export type OfficeApproval = {
  id: string; orgId: string; agentId: string; agentName: string; agentKind: string; kind: OfficeActionRow['kind']; purpose: string
  payload: ActionPayload; payloadHash: string; statusReason: string | null; policyVersion: number | null; createdAt: string; source: 'office'
}

export async function listOfficePendingApprovals(db: Db, orgId: string): Promise<OfficeApproval[]> {
  const rows = await db.query<OfficeActionRow & { agent_name: string; agent_kind: string }>(`select a.*, g.name as agent_name, g.kind as agent_kind from office_actions a join office_agents g on g.id = a.agent_id
    where a.org_id = $1 and a.status = 'awaiting_approval' order by a.created_at desc limit 200`, [orgId])
  return rows.map(r => ({ id: r.id, orgId: r.org_id, agentId: r.agent_id, agentName: r.agent_name, agentKind: r.agent_kind, kind: r.kind, purpose: r.purpose, payload: r.payload, payloadHash: r.payload_hash,
    statusReason: r.status_reason, policyVersion: r.policy_version, createdAt: r.created_at, source: 'office' }))
}

export async function decideOfficeAction(db: Db, actor: Actor, actionId: string, decision: 'approve' | 'reject', opts: { shownHash?: string } = {}) {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff can view but not approve a customer\'s actions')
  const owner = await db.one<{ agent_id: string; org_id: string }>('select agent_id, org_id from office_actions where id = $1', [actionId])
  if (!owner) throw new EngineError('not_found', 'action not found')
  assertMerchant(actor, owner.org_id)
  if (decision === 'approve') await assertCan(actor, owner.org_id, 'approve', db) // owners and admins; members only when the owner allows it
  await db.query('select id from office_agents where id = $1 for share', [owner.agent_id])
  const a = (await db.one<OfficeActionRow>('select * from office_actions where id = $1 for update', [actionId]))!
  if (a.status !== 'awaiting_approval') throw new EngineError('not_pending', `this item is ${a.status.replace('_', ' ')}`)
  if (opts.shownHash !== undefined && opts.shownHash !== a.payload_hash) throw new EngineError('hash_mismatch', 'the item changed after you opened it; review it again')
  if (decision === 'reject') {
    await db.query(`update office_actions set status = 'rejected', status_reason = 'declined by you', next_attempt_at = null where id = $1`, [a.id])
    if (a.lead_id && (a.payload as { meta?: { touch?: number } }).meta?.touch) await db.query(`update office_leads set status = 'stopped', stop_reason = 'you declined the email', next_touch_at = null where id = $1 and status = 'active'`, [a.lead_id])
    await officeAudit(db, { orgId: a.org_id, entityType: 'office_action', entityId: a.id, event: 'action.rejected', actor: actor.label, detail: { kind: a.kind, payload_hash: a.payload_hash } })
    return { actionId, status: 'rejected' as const }
  }
  const ctx = await agentCtx(db, a.agent_id)
  if (!ctx || ctx.agent.status !== 'active' || !ctx.policy || ctx.policyStatus !== 'active') throw new EngineError('agent_inactive', 'the agent is not active; resume it before approving')
  const tool = ctx.policy[TOOL_OF[a.kind]]
  if (!tool || tierRank(tool.tier) < tierRank('send_approved')) throw new EngineError('invalid_input', `this agent may only draft for the ${TOOL_OF[a.kind]} tool; widen its permission first`)
  // the first reply to a new sender: an owner or admin approves it, and that approval trusts the sender for later replies
  const src = a.payload.type === 'email' && a.payload.recipientSource.kind === 'inbound' ? a.payload.recipientSource.inboundId : null
  const firstContact = src ? await needsFirstReplyApproval(db, a.org_id, src) : false
  if (firstContact) await assertCan(actor, a.org_id, 'agent.grant', db)
  await db.query(`update office_actions set status = 'queued', status_reason = 'approved by you', approval_kind = 'individual', approved_by = $2, approved_hash = payload_hash, approved_at = now(),
    policy_id = $3, policy_version = $4, next_attempt_at = null where id = $1`, [a.id, actor.label, ctx.policyId, ctx.policyVersion])
  await officeAudit(db, { orgId: a.org_id, entityType: 'office_action', entityId: a.id, event: 'action.approved', actor: actor.label, detail: { kind: a.kind, payload_hash: a.payload_hash, policy_version: ctx.policyVersion } })
  if (firstContact && a.payload.type === 'email') await trustSender(db, { orgId: a.org_id, address: a.payload.to, actor: actor.label, sourceRef: `office_action:${a.id}` })
  return { actionId, status: 'queued' as const }
}

/** Approve the exact item shown (bound to its hash) and carry it out. */
export async function approveOfficeAction(actor: Actor, actionId: string, shownHash: string, opts: { now?: Date } = {}) {
  await admin(db => decideOfficeAction(db, actor, actionId, 'approve', { shownHash }))
  return executeOfficeAction(actionId, { actor: actor.label, now: opts.now })
}

export async function rejectOfficeAction(actor: Actor, actionId: string, opts: { now?: Date } = {}) {
  const r = await admin(db => decideOfficeAction(db, actor, actionId, 'reject'))
  await actionSettled(actionId, opts.now ?? new Date())
  return r
}

/** Edit an email's subject or body (or an event's title and description) before it goes out. Any change clears an earlier approval. */
export async function editOfficeAction(actor: Actor, actionId: string, patch: { subject?: string; body?: string; summary?: string; description?: string; shownHash: string }) {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff cannot edit a customer\'s actions')
  return admin(async db => {
    const owner = await db.one<{ agent_id: string; org_id: string }>('select agent_id, org_id from office_actions where id = $1', [actionId])
    if (!owner) throw new EngineError('not_found', 'action not found')
    assertMerchant(actor, owner.org_id)
    await db.query('select id from office_agents where id = $1 for share', [owner.agent_id])
    const a = (await db.one<OfficeActionRow>('select * from office_actions where id = $1 for update', [actionId]))!
    if (!['draft', 'awaiting_approval', 'queued'].includes(a.status)) throw new EngineError('not_pending', 'only items that have not been carried out can be edited')
    if (patch.shownHash !== a.payload_hash) throw new EngineError('hash_mismatch', 'the item changed after you opened it; review it again')
    let next: ActionPayload
    if (a.payload.type === 'email') next = { ...a.payload, subject: (patch.subject ?? a.payload.subject).replace(/[\r\n]+/g, ' ').slice(0, 250), body: (patch.body ?? a.payload.body).slice(0, 50_000) }
    else if (a.payload.type === 'event') next = { ...a.payload, summary: (patch.summary ?? a.payload.summary).slice(0, 200), description: (patch.description ?? a.payload.description).slice(0, 2000) }
    else throw new EngineError('invalid_input', 'only emails and calendar events can be edited; decline a CRM change instead')
    const hash = payloadHash(next)
    if (hash === a.payload_hash) return { payloadHash: hash, status: a.status }
    const status = a.status === 'draft' ? 'draft' : 'awaiting_approval'
    await db.query(`update office_actions set payload = $2, payload_hash = $3, status = $4, status_reason = $5, approval_kind = null, approved_by = null, approved_hash = null, approved_at = null where id = $1`,
      [a.id, JSON.stringify(next), hash, status, status === 'draft' ? 'edited draft' : 'edited: waiting for your approval of the new version'])
    await officeAudit(db, { orgId: a.org_id, entityType: 'office_action', entityId: a.id, event: 'action.edited', actor: actor.label, detail: { kind: a.kind, approval_cleared: Boolean(a.approved_hash), old_hash: a.payload_hash, new_hash: hash } })
    return { payloadHash: hash, status }
  })
}
