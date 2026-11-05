/**
 * Decisions on cases themselves. Most cases wait on an item another approval source already owns (an
 * engine proposal, an agent email, an Office action) and are decided there. A case kind whose decision is
 * the case itself registers a handler here; its waiting cases then appear in the unified approvals inbox
 * as the `case` source, with a content hash over exactly what the person is shown.
 *
 * The handler makes the decision through its own path and must follow the engine's rules: an action is
 * not a resolution (resolve only with verification evidence from a fresh read).
 */
import { createHash } from 'node:crypto'
import { admin, type Db } from '../db'
import { canonicalJson } from '../engine/hash'
import { EngineError } from '../engine/errors'
import type { Actor } from '../engine/actor'
import type { ApprovalItem, ApprovalSource, DecisionResult } from '../approvals/registry'
import type { CaseRow } from './index'

export type CaseDecisionHandler = {
  /** what approving does, in one line */
  title(c: CaseRow): string
  approve(c: CaseRow, actor: Exclude<Actor, { kind: 'staff' }>): Promise<DecisionResult>
  reject(c: CaseRow, actor: Exclude<Actor, { kind: 'staff' }>, reason?: string): Promise<DecisionResult>
}

const handlers = new Map<string, CaseDecisionHandler>()
export function registerCaseDecision(kind: string, h: CaseDecisionHandler) { handlers.set(kind, h) }
export const caseDecisionKinds = () => [...handlers.keys()]

/** The hash a decision must carry: everything the person is shown about the decision. */
export function caseVersion(c: Pick<CaseRow, 'id' | 'ref' | 'status' | 'title' | 'problem' | 'why_it_matters' | 'next_action' | 'evidence' | 'records'>): string {
  return createHash('sha256').update(canonicalJson({ v: 1, id: c.id, ref: c.ref, status: c.status, title: c.title, problem: c.problem, why: c.why_it_matters, next: c.next_action, evidence: c.evidence, records: c.records })).digest('hex')
}

function item(c: CaseRow, h: CaseDecisionHandler): ApprovalItem {
  return {
    source: 'case', id: c.id, orgId: c.org_id, kind: `case_${c.kind}`, title: h.title(c),
    agent: c.agent_ref ? { id: c.agent_ref, name: null } : null,
    createdAt: new Date(c.updated_at).toISOString(), expiresAt: c.deadline_at ? new Date(c.deadline_at).toISOString() : null,
    version: caseVersion(c), decisions: ['approve', 'reject'], why: c.status_reason,
    content: { case: c.ref, problem: c.problem, whyItMatters: c.why_it_matters, nextAction: c.next_action, records: c.records, verification: c.verification },
  }
}

const WAITING = `status = 'awaiting_approval' and approval_required`

export const caseSource: ApprovalSource = {
  key: 'case',
  label: 'Case decisions',
  async list(db: Db, orgId: string) {
    const kinds = caseDecisionKinds()
    if (!kinds.length) return []
    const rows = await db.query<CaseRow>(`select * from cases where org_id = $1 and ${WAITING} and kind = any($2::text[]) order by updated_at desc limit 100`, [orgId, kinds])
    return rows.flatMap(c => { const h = handlers.get(c.kind); return h ? [item(c, h)] : [] })
  },
  async find(db: Db, orgId: string, id: string) {
    const c = await db.one<CaseRow>(`select * from cases where org_id = $1 and id = $2 and ${WAITING}`, [orgId, id])
    const h = c ? handlers.get(c.kind) : undefined
    return c && h ? item(c, h) : null
  },
  async decide(_db, actor, id, decision, input) {
    // re-read under a row lock as the service role and re-check the hash, so the decision covers exactly what was shown
    const c = await admin(db => db.one<CaseRow>(`select * from cases where id = $1 and org_id = $2 and ${WAITING} for update`, [id, actor.orgId]))
    if (!c) throw new EngineError('not_found', 'this case is not waiting for a decision')
    if (caseVersion(c) !== input.version) throw new EngineError('hash_mismatch', 'this case changed after you opened it; review it again')
    const h = handlers.get(c.kind)
    if (!h) throw new EngineError('not_found', 'this case is decided where its work lives')
    return decision === 'approve' ? h.approve(c, actor) : h.reject(c, actor, input.reason)
  },
}
