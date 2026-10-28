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

export async function approveProposal(actor: Actor, proposalId: string, shownChangeHash: string, opts: { now?: Date; ip?: string | null } = {}): Promise<{ approvalId: string }> {
  const now = opts.now ?? new Date()
  // Org isolation first: the actor must be able to see the proposal through RLS.
  const visible = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from proposals where id = $1', [proposalId]), { ip: opts.ip })
  if (!visible) throw new EngineError('not_found', 'proposal not found')
  assertMerchant(actor, visible.org_id)

  return admin(async db => {
    const p = await db.one<ProposalRow>('select * from proposals where id = $1 for update', [proposalId])
    if (!p) throw new EngineError('not_found', 'proposal not found')
    if (p.status !== 'pending_approval') throw new EngineError('not_pending', `proposal is ${p.status}`, { status: p.status })
    if (new Date(p.expires_at).getTime() <= now.getTime()) {
      await invalidateProposal(db, p, 'expired', 'not approved before its time limit', actor.label)
      throw new EngineError('expired', 'proposal expired; run a new scan')
    }
    if (shownChangeHash !== p.change_hash) {
      await audit(db, { orgId: p.org_id, connectionId: p.connection_id, entityType: 'proposal', entityId: p.id, event: 'approval.refused', actor: actor.label, detail: { reason: 'hash_mismatch' } })
      throw new EngineError('hash_mismatch', 'the change you approved is not the current proposal; reload and review it again')
    }
    const issue = await db.one<{ check_key: string; status: string }>('select check_key, status from issues where id = $1', [p.issue_id])
    const rule = await db.one<{ version: number; enabled: boolean }>('select version, enabled from merchant_rules where connection_id = $1 and check_key = $2', [p.connection_id, issue?.check_key])
    if (!rule || !rule.enabled || rule.version !== p.rule_version) {
      await invalidateProposal(db, p, 'stale', 'the rule changed after this proposal was made', actor.label)
      throw new EngineError('rule_changed', 'the rule changed after this proposal was made; run a new scan')
    }
    const a = await db.one<{ id: string }>(
      `insert into approvals (org_id, proposal_id, change_hash, approved_by, approver_kind, approved_at) values ($1,$2,$3,$4,$5,$6) returning id`,
      [p.org_id, p.id, p.change_hash, actor.label, approverKind(actor), now.toISOString()])
    await db.query(`update proposals set status = 'approved', decided_at = $2 where id = $1`, [p.id, now.toISOString()])
    await audit(db, { orgId: p.org_id, connectionId: p.connection_id, entityType: 'approval', entityId: a!.id, event: 'approval.granted', actor: actor.label,
      detail: { proposal_id: p.id, change_hash: p.change_hash, change: p.change, target_id: p.target_id } })
    return { approvalId: a!.id }
  }, { ip: opts.ip })
}
