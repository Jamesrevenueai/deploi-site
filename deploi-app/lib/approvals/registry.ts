/**
 * Unified approvals: one list of everything waiting on a merchant, from any source (engine store
 * changes, agent emails, library actions, and later Deploi Office), and one way to decide each item.
 *
 * A source registers { key, label, list, find, decide }. The registry adds the guarantees every source
 * gets the same way:
 *  - organization: only a merchant user of the organization lists or decides (staff list read-only);
 *    an item is first looked up through the actor's RLS view (find), so another organization's item is
 *    simply not found;
 *  - binding: a decision carries the `version` the person was shown (a content hash); a different
 *    version is refused as stale, before the source is called;
 *  - expiry: an item past expiresAt is refused;
 *  - decisions: only those the item offers (a drafts-only agent's change can only be rejected).
 * The source's own decide path re-checks atomically (approveProposal and approveMessage bind to the
 * hash again under a row lock), so the registry check cannot be raced into approving other content.
 */
import { withActor, assertMerchant, type Actor } from '../engine/actor'
import type { Db } from '../db'
import { EngineError } from '../engine/errors'

export type ApprovalDecision = 'approve' | 'reject'

export type ApprovalItem = {
  source: string
  id: string
  orgId: string
  kind: string
  /** one line: what approving does */
  title: string
  agent: { id: string | null; name: string | null } | null
  createdAt: string
  expiresAt: string | null
  /** the content hash a decision must carry */
  version: string
  decisions: ApprovalDecision[]
  /** why it waits (the agent's tier, a blocker of its standing authorization, ...) */
  why: string | null
  /** the exact content the decision covers: for emails sender, recipients, subject and body; for store changes the field from -> to and the evidence */
  content: Record<string, unknown>
}

export type DecisionInput = { version: string; edits?: Record<string, unknown>; reason?: string; ip?: string | null }
export type DecisionResult = { status: string; reason?: string | null; [k: string]: unknown }

export type ApprovalSource = {
  key: string
  label: string
  /** pending items of the organization, read through `db` (the actor's RLS view) */
  list(db: Db, orgId: string): Promise<ApprovalItem[]>
  /** one pending item by id through the same RLS view, or null (not pending, or not visible) */
  find(db: Db, orgId: string, id: string): Promise<ApprovalItem | null>
  /** make the decision through the source's own path; `db` is the actor's RLS view */
  decide(db: Db, actor: Exclude<Actor, { kind: 'staff' }>, id: string, decision: ApprovalDecision, input: DecisionInput): Promise<DecisionResult>
}

const sources = new Map<string, ApprovalSource>()
const SOURCE_KEY = /^[a-z][a-z0-9_-]{1,40}$/

export function registerApprovalSource(s: ApprovalSource) {
  if (!SOURCE_KEY.test(s.key)) throw new Error(`invalid approval source key: ${s.key}`)
  sources.set(s.key, s)
}
export const approvalSources = () => [...sources.values()].map(s => ({ key: s.key, label: s.label }))
export const getApprovalSource = (key: string) => sources.get(key) ?? null

function orgOf(actor: Actor, orgId?: string): string {
  if (actor.kind === 'staff') {
    if (!orgId) throw new EngineError('invalid_input', 'staff must name the organization to view its approvals')
    return orgId
  }
  return actor.orgId
}

/** Everything pending for the organization, newest first. A failing source is reported, never hides the others. */
export async function listPendingApprovals(actor: Actor, opts: { orgId?: string; source?: string | null; now?: Date } = {}): Promise<{ items: ApprovalItem[]; errors: { source: string; message: string }[] }> {
  const orgId = orgOf(actor, opts.orgId)
  const now = (opts.now ?? new Date()).getTime()
  const items: ApprovalItem[] = []
  const errors: { source: string; message: string }[] = []
  for (const s of sources.values()) {
    if (opts.source && s.key !== opts.source) continue
    try {
      const got = await withActor(actor, db => s.list(db, orgId))
      for (const it of got) if (it.orgId === orgId && (!it.expiresAt || new Date(it.expiresAt).getTime() > now)) items.push(actor.kind === 'staff' ? { ...it, decisions: [] } : it)
    } catch (e) { errors.push({ source: s.key, message: (e as Error).message.slice(0, 200) }) }
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { items, errors }
}

/** Decide one item. Refuses: unknown source, another organization's item, a stale version, an expired item, a decision the item does not offer. */
export async function decideApproval(actor: Actor, sourceKey: string, id: string, decision: ApprovalDecision, input: DecisionInput, opts: { now?: Date } = {}): Promise<DecisionResult & { source: string; id: string }> {
  const s = sources.get(sourceKey)
  if (!s) throw new EngineError('not_found', 'unknown approval source')
  if (decision !== 'approve' && decision !== 'reject') throw new EngineError('invalid_input', 'decision must be approve or reject')
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff can view but not approve or reject for a merchant')
  if (typeof input.version !== 'string' || !input.version) throw new EngineError('invalid_input', 'the version you were shown is required')
  const item = await withActor(actor, db => s.find(db, actor.orgId, id), { ip: input.ip })
  if (!item) throw new EngineError('not_found', 'this item is not waiting for a decision')
  assertMerchant(actor, item.orgId)
  if (item.expiresAt && new Date(item.expiresAt).getTime() <= (opts.now ?? new Date()).getTime()) throw new EngineError('expired', 'this item expired before it was decided; run the agent again for a fresh one')
  if (item.version !== input.version) throw new EngineError('hash_mismatch', 'this item changed after you opened it; review it again')
  if (!item.decisions.includes(decision)) throw new EngineError('forbidden', decision === 'approve' ? 'this item can only be rejected (its agent is drafts only)' : 'this item cannot be rejected here')
  const r = await withActor(actor, db => s.decide(db, actor, id, decision, input), { ip: input.ip })
  return { ...r, source: s.key, id }
}
