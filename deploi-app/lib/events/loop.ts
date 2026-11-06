/**
 * The agent loop every agent follows. SHARED INTERFACE — owned by workstream W1 (which hardens the internals:
 * cases with evidence, approvals for ask_first, undo tokens, reminders for an owner who never replies, blocked
 * cases when an agent cannot finish, one job per case). Pack workstreams call runAgentLoop and do not change it.
 *
 *   detect -> (mode check) -> act -> verify with a fresh read -> log proof -> notify the owner
 */
import type { Db } from '../db'
import { modeFor, type ActionMode } from '../autonomy'
import { notifyOwner, type ProofItem } from '../notify'

export type LoopSpec<P> = {
  orgId: string
  agentKey: string
  agentName: string
  /** autonomy action type, e.g. 'refund', 'send_customer_email', 'update_listing' */
  actionType: string
  /** stable key for this problem, so the same problem is never handled twice (e.g. 'order:1001:stuck') */
  problemKey: string
  /** find the problem; null when there is nothing to do */
  detect: (db: Db) => Promise<P | null>
  /** what the agent will do, in plain words (shown to the owner before or after) */
  describe: (p: P) => { title: string; whatHappened: string; whatIDid: string[] }
  /** do it; return how to undo it when it can be undone */
  act: (db: Db, p: P) => Promise<{ undo?: { kind: string; payload: Record<string, unknown> } | null; proof?: ProofItem[] }>
  /** read the source again and confirm the fix holds */
  verify: (db: Db, p: P) => Promise<{ ok: boolean; proof: ProofItem[] }>
  detailsPath?: string
}
export type LoopOutcome =
  | { status: 'nothing_to_do' }
  | { status: 'done'; verified: true; proof: ProofItem[]; mode: ActionMode }
  | { status: 'not_verified'; proof: ProofItem[] }
  | { status: 'waiting_for_owner'; approvalId: string | null }
  | { status: 'failed'; error: string }

export async function runAgentLoop<P>(db: Db, s: LoopSpec<P>): Promise<LoopOutcome> {
  let p: P | null
  try { p = await s.detect(db) } catch (e) { return { status: 'failed', error: (e as Error).message } }
  if (!p) return { status: 'nothing_to_do' }
  const d = s.describe(p)
  const mode = await modeFor(db, s.orgId, s.actionType)
  const base = { orgId: s.orgId, agentKey: s.agentKey, agentName: s.agentName, headline: d.title, whatHappened: d.whatHappened, detailsPath: s.detailsPath ?? '/store/work' }
  if (mode === 'ask_first') {
    await notifyOwner({ ...base, whatIDid: ['Prepared this for you; nothing has been done yet.', ...d.whatIDid], proof: [], severity: 'action', dedupeKey: `${s.agentKey}:${s.problemKey}:ask` })
    return { status: 'waiting_for_owner', approvalId: null }
  }
  try {
    const done = await s.act(db, p)
    const v = await s.verify(db, p)
    const proof = [...(done.proof ?? []), ...v.proof]
    if (!v.ok) {
      await notifyOwner({ ...base, whatIDid: d.whatIDid, proof, severity: 'warning', dedupeKey: `${s.agentKey}:${s.problemKey}:unverified` })
      return { status: 'not_verified', proof }
    }
    await notifyOwner({ ...base, whatIDid: d.whatIDid, proof, severity: 'info', dedupeKey: `${s.agentKey}:${s.problemKey}:done` })
    return { status: 'done', verified: true, proof, mode }
  } catch (e) {
    return { status: 'failed', error: (e as Error).message }
  }
}
