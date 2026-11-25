/**
 * Approvals source `agent_action`: every agent-loop action waiting for the owner (ask_first), with the exact
 * action the agent will take. It stays in the inbox while the case is escalated (no answer in 3 days), until
 * the owner decides. Approve queues the action (lib/events/loop.ts approveLoop); reject cancels it. The registry
 * checks organization, role (approve: owners and admins), version and expiry before decide is called; decide
 * re-reads the loop under a row lock and re-checks the version.
 */
import { createHash } from 'node:crypto'
import { admin, type Db } from '../db'
import { canonicalJson } from '../engine/hash'
import { EngineError } from '../engine/errors'
import { isMoneyAction } from '../autonomy'
import type { ApprovalItem, ApprovalSource } from '../approvals/registry'
import { approveLoop, rejectLoop, type LoopRow } from './loop'

type Row = LoopRow & { case_ref: string | null; case_status: string | null }
const SQL = `select l.*, c.ref as case_ref, c.status as case_status from agent_loops l left join cases c on c.id = l.case_id where l.org_id = $1 and l.state = 'awaiting_owner'`

export const loopVersion = (l: Pick<LoopRow, 'id' | 'state' | 'action' | 'action_type' | 'problem_key' | 'agent_key'>) =>
  createHash('sha256').update(canonicalJson({ v: 1, id: l.id, state: l.state, action: l.action, actionType: l.action_type, problemKey: l.problem_key, agent: l.agent_key })).digest('hex')

function item(l: Row): ApprovalItem {
  return {
    source: 'agent_action', id: l.id, orgId: l.org_id, kind: `agent_${l.action_type}`.slice(0, 64),
    title: l.action.title ?? 'An agent is waiting for your decision',
    agent: { id: l.agent_key, name: l.agent_name || l.agent_key },
    createdAt: new Date(l.asked_at ?? l.created_at).toISOString(), expiresAt: null, version: loopVersion(l), decisions: ['approve', 'reject'],
    why: l.escalated_at ? 'You asked to approve this kind of action first. It has waited 3 days.' : 'You asked to approve this kind of action first.',
    content: { case: l.case_ref, caseStatus: l.case_status, actionType: l.action_type, money: isMoneyAction(l.action_type), whatHappened: l.action.whatHappened ?? null, whatTheAgentWillDo: l.action.whatIDid ?? [], remindedAt: l.reminded_at, escalatedAt: l.escalated_at },
  }
}

export const loopSource: ApprovalSource = {
  key: 'agent_action',
  label: 'Agent actions',
  async list(db: Db, orgId: string) { return (await db.query<Row>(`${SQL} order by l.created_at desc limit 200`, [orgId])).map(item) },
  async find(db: Db, orgId: string, id: string) { const r = await db.one<Row>(`${SQL} and l.id = $2`, [orgId, id]); return r ? item(r) : null },
  async decide(_db, actor, id, decision, input) {
    return admin(async db => {
      const l = await db.one<LoopRow>(`select * from agent_loops where id = $1 and org_id = $2 and state = 'awaiting_owner' for update`, [id, actor.orgId])
      if (!l) throw new EngineError('not_found', 'this action is not waiting for a decision')
      if (loopVersion(l) !== input.version) throw new EngineError('hash_mismatch', 'this action changed after you opened it; review it again')
      if (decision === 'approve') return { ...(await approveLoop(db, id, actor.orgId, actor.label)) }
      return { ...(await rejectLoop(db, id, actor.orgId, actor.label, input.reason)) }
    })
  },
}
