/**
 * Approval binds a merchant user to one exact change: the proposal id AND the change hash the
 * user was shown. A different hash (the proposal changed after the page loaded), an expired
 * proposal, a changed rule or a proposal that is no longer waiting all refuse the approval.
 */
import { admin } from '../db'
import { audit } from './audit'
import { assertMerchant, approverKind, withActor, type Actor } from './actor'
import { EngineError } from './errors'
import { invalidateProposal, type ProposalRow } from './proposals'
import { assertCan } from '../platform/rbac'

export async function approveProposal(actor: Actor, proposalId: string, shownChangeHash: string, opts: { now?: Date; ip?: string | null } = {}): Promise<{ approvalId: string }> {
  const now = opts.now ?? new Date()
  // Org isolation first: the actor must be able to see the proposal through RLS.
  const visible = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from proposals where id = $1', [proposalId]), { ip: opts.ip })
  if (!visible) throw new EngineError('not_found', 'proposal not found')
  assertMerchant(actor, visible.org_id)
  await assertCan(actor, visible.org_id, 'approve') // owners and admins; members only when the owner allows it

  // A refusal that retires the proposal (expired, agent inactive, rule changed) is committed before the
  // error is raised, so the proposal and its case show why it can no longer be approved.
  type Refusal = { error: EngineError; invalidate?: { status: 'stale' | 'expired' | 'blocked'; reason: string } }
  const out = await admin(async (db): Promise<{ approvalId: string } | Refusal> => {
    const p = await db.one<ProposalRow>('select * from proposals where id = $1 for update', [proposalId])
    if (!p) throw new EngineError('not_found', 'proposal not found')
    if (p.status !== 'pending_approval') throw new EngineError('not_pending', `proposal is ${p.status}`, { status: p.status })
    if (new Date(p.expires_at).getTime() <= now.getTime()) {
      return { error: new EngineError('expired', 'proposal expired; run a new scan'), invalidate: { status: 'expired', reason: 'not approved before its time limit' } }
    }
    if (shownChangeHash !== p.change_hash) {
      await audit(db, { orgId: p.org_id, connectionId: p.connection_id, entityType: 'proposal', entityId: p.id, event: 'approval.refused', actor: actor.label, detail: { reason: 'hash_mismatch' } })
      throw new EngineError('hash_mismatch', 'the change you approved is not the current proposal; reload and review it again')
    }
    if (p.agent_id) {
      // an agent's proposal can be approved only while the agent is active under the same authorization version
      const agent = await db.one<{ status: string; version: number | null; mode: string | null }>(
        `select a.status, ap.version, ap.policy->>'approvalMode' as mode from agents a left join agent_policies ap on ap.id = a.active_policy_id and ap.status = 'active' where a.id = $1`, [p.agent_id])
      if (!agent || agent.status !== 'active') {
        return { error: new EngineError('agent_inactive', `the agent is ${agent?.status ?? 'deleted'}; resume it to approve its changes`), invalidate: { status: 'blocked', reason: `the agent is ${agent?.status ?? 'deleted'}` } }
      }
      if (agent.mode !== 'review' && agent.mode !== 'autonomous') {
        // drafts only (or anything unrecognised): approving would make a change the grant does not allow
        await audit(db, { orgId: p.org_id, connectionId: p.connection_id, entityType: 'proposal', entityId: p.id, event: 'approval.refused', actor: actor.label, detail: { reason: 'drafts_only' } })
        throw new EngineError('forbidden', 'this agent is drafts only: it may show changes but not make them. Give it permission to make changes you approve (a new grant) first')
      }
      if (agent.version !== p.policy_version) {
        return { error: new EngineError('rule_changed', "the agent's authorization changed after this proposal was made; run the agent again"), invalidate: { status: 'stale', reason: "the agent's authorization changed after this proposal was made" } }
      }
    } else {
      const issue = await db.one<{ check_key: string; status: string }>('select check_key, status from issues where id = $1', [p.issue_id])
      const rule = await db.one<{ version: number; enabled: boolean }>('select version, enabled from merchant_rules where connection_id = $1 and check_key = $2', [p.connection_id, issue?.check_key])
      if (!rule || !rule.enabled || rule.version !== p.rule_version) {
        return { error: new EngineError('rule_changed', 'the rule changed after this proposal was made; run a new scan'), invalidate: { status: 'stale', reason: 'the rule changed after this proposal was made' } }
      }
    }
    const a = await db.one<{ id: string }>(
      `insert into approvals (org_id, proposal_id, change_hash, approved_by, approver_kind, approved_at) values ($1,$2,$3,$4,$5,$6) returning id`,
      [p.org_id, p.id, p.change_hash, actor.label, approverKind(actor), now.toISOString()])
    await db.query(`update proposals set status = 'approved', decided_at = $2 where id = $1`, [p.id, now.toISOString()])
    await audit(db, { orgId: p.org_id, connectionId: p.connection_id, entityType: 'approval', entityId: a!.id, event: 'approval.granted', actor: actor.label,
      detail: { proposal_id: p.id, change_hash: p.change_hash, change: p.change, target_id: p.target_id } })
    return { approvalId: a!.id }
  }, { ip: opts.ip })
  const { syncProposalCase } = await import('./case-sync')
  if ('error' in out) {
    if (out.invalidate) {
      const inv = out.invalidate
      await admin(async db => {
        const p = await db.one<ProposalRow>('select * from proposals where id = $1', [proposalId])
        if (p) await invalidateProposal(db, p, inv.status, inv.reason, actor.label)
      }, { ip: opts.ip })
      await syncProposalCase(proposalId, { actor: actor.label })
    }
    throw out.error
  }
  await syncProposalCase(proposalId, { actor: actor.label })
  return out
}
