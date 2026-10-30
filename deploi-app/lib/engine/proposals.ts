/** Proposal lifecycle helpers shared by scans, approvals and executions (all run with the service role). */
import type { Db } from '../db'
import { audit } from './audit'

export type ProposalRow = {
  id: string; org_id: string; connection_id: string; issue_id: string; platform: string; action_key: string
  target_type: string; target_id: string; target_label: string | null
  change: { field: string; from: unknown; to: unknown }; preconditions: { path: string; equals: unknown; description: string }[]
  rule_version: number | null; change_hash: string; status: string; status_reason: string | null
  expires_at: string; decided_at: string | null; created_at: string; updated_at: string
  agent_id?: string | null; policy_id?: string | null; policy_version?: number | null
}

export const LIVE_PROPOSAL = ['pending_approval', 'approved', 'executing', 'applied'] as const
export const INVALIDATABLE = ['pending_approval', 'approved'] as const

/** Retire a proposal that has not started executing; any approval on it is revoked with the same reason. */
export async function invalidateProposal(db: Db, p: Pick<ProposalRow, 'id' | 'org_id' | 'connection_id'>, status: 'stale' | 'superseded' | 'expired' | 'dismissed' | 'blocked', reason: string, actor: string): Promise<boolean> {
  const r = await db.query<{ id: string }>(
    `update proposals set status = $2, status_reason = $3 where id = $1 and status = any($4::text[]) returning id`,
    [p.id, status, reason, [...INVALIDATABLE]])
  if (!r.length) return false
  await db.query(`update approvals set revoked_at = now(), revoke_reason = $2 where proposal_id = $1 and revoked_at is null`, [p.id, `proposal ${status}: ${reason}`])
  await audit(db, { orgId: p.org_id, connectionId: p.connection_id, entityType: 'proposal', entityId: p.id, event: `proposal.${status}`, actor, detail: { reason } })
  return true
}

/** Expire unapproved or never-executed proposals past their time limit. */
export async function expireProposals(db: Db, connectionId: string | null, now: Date, actor = 'system:expiry'): Promise<number> {
  const rows = await db.query<ProposalRow>(
    `select * from proposals where status = any($1::text[]) and expires_at <= $2 ${connectionId ? 'and connection_id = $3' : ''}`,
    connectionId ? [[...INVALIDATABLE], now.toISOString(), connectionId] : [[...INVALIDATABLE], now.toISOString()])
  let n = 0
  for (const p of rows) if (await invalidateProposal(db, p, 'expired', 'not approved and run before its time limit', actor)) n++
  return n
}
