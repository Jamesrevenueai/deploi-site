/**
 * The agent loop every agent follows. SHARED INTERFACE — owned by workstream W1 (which hardens the internals:
 * cases with evidence, approvals for ask_first, undo tokens, reminders for an owner who never replies, blocked
 * cases when an agent cannot finish, one job per case). Pack workstreams call runAgentLoop and do not change it.
 *
 *   detect -> (mode check) -> act -> verify with a fresh read -> log proof -> notify the owner
 *
 * What the loop guarantees, whichever agent runs it:
 *  - ONE open loop and ONE case per problem (organization + problemKey): the loop row (agent_loops, unique while
 *    open) is the claim. A second agent that finds the problem owned by another agent stops and leaves a note on
 *    the case; a second run of the same agent while the first is acting stops too.
 *  - act_and_tell: act, verify with a fresh read, resolve the case with the verification proof as evidence,
 *    register an undo token when the action can be reversed, tell the owner (with the undo link).
 *  - ask_first: the case waits for the owner (awaiting_approval) and the exact action is an item in the unified
 *    approvals inbox (source `agent_action`, lib/events/approvals.ts); the owner is told (severity action).
 *    Approving queues `loop.resume`: the agent's resumer (registerLoopResumer) rebuilds the spec and the loop acts,
 *    verifies and tells; without a resumer the agent's next run (event or sweep) carries it out.
 *  - An owner who never answers: a reminder after 24 hours, the case escalated after 72 hours (the case's own
 *    durable check, kind `agent_action`; testable with an injected clock through runCaseCheck(id, now)).
 *  - act throws or verify fails: the case is blocked with the reason, the owner is told once, and the loop retries
 *    after a backoff (30 min, 2 h) up to MAX_ATTEMPTS; then the case fails and the owner is told it needs them.
 *  - Re-runs are idempotent: a waiting loop answers waiting_for_owner, a blocked loop before its retry time
 *    answers failed with the same reason, a finished problem is not detected again.
 * Bookkeeping (cases, loops, approvals, undo) is written in its own service-role transactions, so a failing act
 * cannot roll back the record of the attempt; detect/act/verify run on the caller's `db` and must not write the
 * loop's case themselves.
 */
import { admin, type Db } from '../db'
import { modeFor, isMoneyAction, type ActionMode } from '../autonomy'
import { openCase, transitionCase, recordAction, resolveCase, addNote, registerCaseKind } from '../cases'
import { EngineError } from '../engine/errors'
import { enqueue } from '../jobs/queue'
import { createUndo } from '../undo'
import { PACK_AGENTS } from '../packs/registry'
import { notifyOwner, type ProofItem, type OwnerUpdate } from '../notify'
import { log } from '../log'
import { isOutboundAction, takeOutboundSlot } from '../autonomy/pacing'
import { currentEvent, EVENT_JOB } from './index'

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
  /** which suite the case belongs to (default: the agent's pack; commerce when unknown) */
  suite?: 'commerce' | 'office'
  /**
   * this loop sends something to a customer, tenant, renter, vendor or supplier: paced in the first 24 hours after a
   * connect (lib/autonomy/pacing.ts). Default: the action type says so. A loop that only wraps a run whose own sends
   * are paced one by one (the Office pack's runs) passes false.
   */
  outbound?: boolean
  /** injected clock (tests) */
  now?: () => Date
}
export type LoopOutcome =
  | { status: 'nothing_to_do'; reason?: 'owned_by_other_agent' | 'in_progress' | 'cleared' | 'queued'; ownerAgent?: string; caseRef?: string | null; releaseAt?: string }
  | { status: 'done'; verified: true; proof: ProofItem[]; mode: ActionMode; caseRef?: string | null; undoToken?: string | null }
  | { status: 'not_verified'; proof: ProofItem[]; caseRef?: string | null; retryAt?: string | null }
  | { status: 'waiting_for_owner'; approvalId: string | null; caseRef?: string | null }
  | { status: 'failed'; error: string; caseRef?: string | null; retryAt?: string | null }

export const LOOP_CASE_KIND = 'agent_action'
export const LOOP_RESUME_JOB = 'loop.resume'
export const REMIND_AFTER_MS = 24 * 3600e3
export const ESCALATE_AFTER_MS = 72 * 3600e3
export const MAX_ATTEMPTS = 3
/** a loop left `acting` longer than this (a crashed worker) can be taken over */
export const STALE_ACTING_MS = 10 * 60_000
export const retryDelayMs = (attempts: number) => 30 * 60_000 * 4 ** Math.max(0, attempts - 1)

export type LoopState = 'acting' | 'awaiting_owner' | 'approved' | 'blocked' | 'done' | 'rejected' | 'cleared' | 'failed'
export const OPEN_LOOP_STATES: LoopState[] = ['acting', 'awaiting_owner', 'approved', 'blocked']
export type LoopRow = {
  id: string; org_id: string; case_id: string | null; agent_key: string; agent_name: string; action_type: string; problem_key: string; mode: ActionMode; state: LoopState
  action: { title?: string; whatHappened?: string; whatIDid?: string[] }; asked_at: string | null; reminded_at: string | null; escalated_at: string | null
  decided_by: string | null; decided_at: string | null; attempts: number; last_error: string | null; next_retry_at: string | null; undo_token_id: string | null; created_at: string; updated_at: string
}

// ---------------------------------------------------------------- resumers (approved actions carried out at once)

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each agent's problem type is its own
export type LoopResumer = (r: { orgId: string; problemKey: string; actionType: string; loopId: string }) => Promise<LoopSpec<any> | null>
const resumers = new Map<string, LoopResumer>()
/** How an agent rebuilds its loop for a stored problem, so an approval (or a due retry) is carried out at once. */
export function registerLoopResumer(agentKey: string, fn: LoopResumer) { resumers.set(agentKey, fn) }

// ---------------------------------------------------------------- helpers

const OPEN_SQL = `state in ('acting','awaiting_owner','approved','blocked')`
const adm = <T>(fn: (db: Db) => Promise<T>): Promise<T> => admin(fn)
const clip = (s: string, n: number) => String(s ?? '').slice(0, n)
const actorOf = (agentKey: string) => `agent:${agentKey}`.slice(0, 160)

async function caseRefOf(caseId: string | null): Promise<string | null> {
  if (!caseId) return null
  return (await adm(db => db.one<{ ref: string }>('select ref from cases where id = $1', [caseId])))?.ref ?? null
}

/** Move the case unless it is already there (or closed). Never throws: bookkeeping must not hide the agent's outcome. */
async function moveCase(caseId: string | null, to: 'executing' | 'verifying' | 'blocked' | 'failed' | 'awaiting_approval' | 'escalated' | 'cancelled', actor: string, reason: string, extra: { nextCheckAt?: Date | null; approvalRequired?: boolean; evidence?: { label: string; source: string; observedAt: string }[] } = {}) {
  if (!caseId) return
  try {
    await adm(async db => {
      const c = await db.one<{ status: string }>('select status from cases where id = $1', [caseId])
      if (!c || c.status === 'resolved' || c.status === 'cancelled') return
      if (c.status === to) {
        await db.query(`update cases set status_reason = $2, next_check_at = case when $3::boolean then $4::timestamptz else next_check_at end, approval_required = coalesce($5, approval_required) where id = $1`,
          [caseId, clip(reason, 1000), extra.nextCheckAt !== undefined, extra.nextCheckAt?.toISOString() ?? null, extra.approvalRequired ?? null])
        return
      }
      await transitionCase(db, caseId, { to, actor, reason, nextCheckAt: extra.nextCheckAt, approvalRequired: extra.approvalRequired, evidence: extra.evidence })
    })
  } catch (e) { log.warn('loop.case_move_failed', { case_id: caseId, to, error: (e as Error).message.slice(0, 200) }) }
}

async function tell(u: OwnerUpdate) {
  try { return await notifyOwner(u) } catch (e) { log.warn('loop.notify_failed', { agent: u.agentKey, error: (e as Error).message.slice(0, 200) }); return null }
}

function suiteFor(agentKey: string, given?: 'commerce' | 'office'): 'commerce' | 'office' {
  if (given) return given
  const a = PACK_AGENTS.find(x => x.key === agentKey)
  return !a || a.pack === 'commerce' ? 'commerce' : 'office'
}

export async function openLoopFor(orgId: string, problemKey: string): Promise<LoopRow | null> {
  return adm(db => db.one<LoopRow>(`select * from agent_loops where org_id = $1 and problem_key = $2 and ${OPEN_SQL}`, [orgId, problemKey]))
}

/** Compare-and-set the loop into `acting` (one runner wins). */
async function claim(l: LoopRow, now: Date): Promise<LoopRow | null> {
  return adm(db => db.one<LoopRow>(`update agent_loops set state = 'acting', attempts = attempts + 1, updated_at = $4 where id = $1 and state = $2 and updated_at = $3 returning *`,
    [l.id, l.state, l.updated_at, now.toISOString()]))
}

async function setLoop(id: string, fields: Record<string, unknown>, now: Date) {
  const keys = Object.keys(fields)
  await adm(db => db.query(`update agent_loops set ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = $2 where id = $1`, [id, now.toISOString(), ...keys.map(k => fields[k])]))
}

// ---------------------------------------------------------------- the loop

export async function runAgentLoop<P>(db: Db, s: LoopSpec<P>): Promise<LoopOutcome> {
  const now = () => s.now?.() ?? new Date()
  let p: P | null
  try { p = await s.detect(db) } catch (e) { return { status: 'failed', error: (e as Error).message } }
  const existing = await openLoopFor(s.orgId, s.problemKey)

  if (!p) {
    // a fresh read no longer finds the problem: close this agent's own waiting or blocked loop
    const stale = existing?.state === 'acting' && now().getTime() - new Date(existing.updated_at).getTime() > STALE_ACTING_MS
    if (existing && existing.agent_key === s.agentKey && (existing.state !== 'acting' || stale)) {
      await setLoop(existing.id, { state: 'cleared' }, now())
      await moveCase(existing.case_id, 'cancelled', actorOf(s.agentKey), 'A fresh read no longer finds the problem; nothing more to do', { approvalRequired: false })
      return { status: 'nothing_to_do', reason: 'cleared', caseRef: await caseRefOf(existing.case_id) }
    }
    return { status: 'nothing_to_do' }
  }
  const d = s.describe(p)
  let loop: LoopRow
  if (existing) {
    const caseRef = await caseRefOf(existing.case_id)
    if (existing.agent_key !== s.agentKey) {
      await noteOnce(existing, s, `${s.agentName} also found this problem; ${existing.agent_name || existing.agent_key} is handling it, so ${s.agentName} stopped.`)
      return { status: 'nothing_to_do', reason: 'owned_by_other_agent', ownerAgent: existing.agent_name || existing.agent_key, caseRef }
    }
    if (existing.state === 'awaiting_owner') return { status: 'waiting_for_owner', approvalId: existing.id, caseRef }
    if (existing.state === 'blocked' && existing.next_retry_at && new Date(existing.next_retry_at) > now()) return { status: 'failed', error: existing.last_error ?? 'blocked', caseRef, retryAt: new Date(existing.next_retry_at).toISOString() }
    if (existing.state === 'acting' && now().getTime() - new Date(existing.updated_at).getTime() <= STALE_ACTING_MS) return { status: 'nothing_to_do', reason: 'in_progress', caseRef }
    const got = await claim(existing, now())
    if (!got) return { status: 'nothing_to_do', reason: 'in_progress', caseRef }
    loop = got
  } else {
    const mode = await modeFor(db, s.orgId, s.actionType)
    const at = now()
    // first-day pacing: an outbound action that goes ahead on its own waits for a later hour when the cap is reached
    if (mode === 'act_and_tell' && (s.outbound ?? isOutboundAction(s.actionType))) {
      const held = await holdIfPaced(s, at)
      if (held) return held
    }
    const created = await createLoop(s, d, mode, at)
    if (!created) {
      // another runner opened it a moment ago: it owns the problem (never act twice, even if it already finished)
      const other = await openLoopFor(s.orgId, s.problemKey)
      if (other && other.agent_key !== s.agentKey) {
        await noteOnce(other, s, `${s.agentName} also found this problem; ${other.agent_name || other.agent_key} is handling it, so ${s.agentName} stopped.`)
        return { status: 'nothing_to_do', reason: 'owned_by_other_agent', ownerAgent: other.agent_name || other.agent_key, caseRef: await caseRefOf(other.case_id) }
      }
      return { status: 'nothing_to_do', reason: 'in_progress', caseRef: other ? await caseRefOf(other.case_id) : null }
    }
    loop = created
    if (mode === 'ask_first') return askOwner(s, loop, d, at)
  }
  return actVerifyTell(db, s, p, d, loop, now)
}

/** Take a first-day pacing slot; when there is none, the handler that found this runs again when the hold ends. */
async function holdIfPaced<P>(s: LoopSpec<P>, at: Date): Promise<LoopOutcome | null> {
  const ev = currentEvent.getStore()
  const slot = await adm(db => takeOutboundSlot(db, s.orgId, `loop:${s.problemKey}`, { agentKey: s.agentKey, actionType: s.actionType, eventId: ev?.eventId ?? null }, at))
  if (slot.ok) return null
  if (ev) {
    await enqueue({ kind: EVENT_JOB, orgId: s.orgId, payload: { eventId: ev.eventId, agentKey: ev.agentKey }, idempotencyKey: `${ev.eventId}:${ev.agentKey}:paced:${slot.releaseAt.toISOString()}`.slice(0, 200), runAfter: slot.releaseAt })
      .catch(e => log.warn('loop.pace_requeue_failed', { error: (e as Error).message.slice(0, 200) }))
  }
  return { status: 'nothing_to_do', reason: 'queued', releaseAt: slot.releaseAt.toISOString() }
}

async function noteOnce(l: LoopRow, s: { agentKey: string }, note: string) {
  if (!l.case_id) return
  const actor = actorOf(s.agentKey)
  await adm(async db => {
    const seen = await db.one('select 1 from case_events where case_id = $1 and type = $2 and actor = $3 limit 1', [l.case_id, 'note', actor])
    if (seen) return
    await addNote(db, l.case_id!, note, actor)
  }).catch(e => log.warn('loop.note_failed', { error: (e as Error).message.slice(0, 200) }))
}

async function createLoop<P>(s: LoopSpec<P>, d: { title: string; whatHappened: string; whatIDid: string[] }, mode: ActionMode, now: Date): Promise<LoopRow | null> {
  return adm(async db => {
    const ask = mode === 'ask_first'
    const l = await db.one<LoopRow>(
      `insert into agent_loops (org_id, agent_key, agent_name, action_type, problem_key, mode, state, action, attempts, asked_at, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       on conflict (org_id, problem_key) where state in ('acting','awaiting_owner','approved','blocked') do nothing returning *`,
      [s.orgId, clip(s.agentKey, 120), clip(s.agentName, 160), clip(s.actionType, 64), clip(s.problemKey, 300), mode, ask ? 'awaiting_owner' : 'acting',
        JSON.stringify({ title: clip(d.title, 300), whatHappened: clip(d.whatHappened, 4000), whatIDid: d.whatIDid.slice(0, 20).map(x => clip(x, 500)) }), ask ? 0 : 1, ask ? now.toISOString() : null, now.toISOString()])
    if (!l) return null
    const title = d.title.trim().length >= 3 ? d.title : `${s.agentName}: ${d.title}`.padEnd(3, '.')
    const { case: c } = await openCase(db, {
      orgId: s.orgId, suite: suiteFor(s.agentKey, s.suite), kind: LOOP_CASE_KIND, sourceApp: 'agent', dedupeKey: `loop:${s.problemKey}`.slice(0, 300),
      title, problem: d.whatHappened || d.title, whyItMatters: isMoneyAction(s.actionType) ? 'This action moves money.' : null,
      priority: isMoneyAction(s.actionType) ? 'high' : 'normal',
      records: [{ type: 'agent', id: s.agentKey, label: s.agentName }, { type: 'action_type', id: s.actionType }, { type: 'agent_loop', id: l.id }],
      verification: { criteria: `A fresh read of the source confirms: ${d.title}`.slice(0, 1000), rule: { loopId: l.id, actionType: s.actionType } },
      nextAction: d.whatIDid.join(' ').slice(0, 1000) || null, actor: actorOf(s.agentKey),
    })
    await db.query('update agent_loops set case_id = $2 where id = $1', [l.id, c.id])
    return { ...l, case_id: c.id }
  })
}

function base<P>(s: LoopSpec<P>, d: { title: string; whatHappened: string }, caseRef: string | null) {
  return { orgId: s.orgId, agentKey: s.agentKey, agentName: s.agentName, caseRef, headline: d.title, whatHappened: d.whatHappened, detailsPath: s.detailsPath ?? (caseRef ? `/store/work/${caseRef}` : '/store/work') }
}

async function askOwner<P>(s: LoopSpec<P>, loop: LoopRow, d: { title: string; whatHappened: string; whatIDid: string[] }, now: Date): Promise<LoopOutcome> {
  await moveCase(loop.case_id, 'awaiting_approval', actorOf(s.agentKey), `Waiting for your decision: ${d.whatIDid.join(' ') || d.title}`, { approvalRequired: true, nextCheckAt: new Date(now.getTime() + REMIND_AFTER_MS) })
  const caseRef = await caseRefOf(loop.case_id)
  await tell({ ...base(s, d, caseRef), whatIDid: ['Prepared this for you; nothing has been done yet.', ...d.whatIDid], proof: [], severity: 'action', dedupeKey: `${s.agentKey}:${s.problemKey}:${loop.id}:ask` })
  return { status: 'waiting_for_owner', approvalId: loop.id, caseRef }
}

async function actVerifyTell<P>(db: Db, s: LoopSpec<P>, p: P, d: { title: string; whatHappened: string; whatIDid: string[] }, loop: LoopRow, now: () => Date): Promise<LoopOutcome> {
  const actor = actorOf(s.agentKey)
  const caseRef = await caseRefOf(loop.case_id)
  await moveCase(loop.case_id, 'executing', actor, loop.decided_by ? `Approved by ${loop.decided_by}; ${s.agentName} is doing it now` : `${s.agentName} is doing it now`, { approvalRequired: false })
  let done: Awaited<ReturnType<LoopSpec<P>['act']>>
  try { done = await s.act(db, p) ?? {} } catch (e) { return block(s, d, loop, `${s.agentName} could not finish: ${(e as Error).message}`, [], now, 'failed') }
  const actProof = done.proof ?? []
  if (loop.case_id) await adm(async x => { await recordAction(x, loop.case_id!, { actor, summary: d.whatIDid.join(' ') || d.title, detail: { proof: actProof } }) }).catch(() => {})
  await moveCase(loop.case_id, 'verifying', actor, 'Reading the source again to confirm the fix holds')
  let v: { ok: boolean; proof: ProofItem[] }
  try { v = await s.verify(db, p) } catch (e) { return block(s, d, loop, `The fix could not be confirmed: ${(e as Error).message}`, actProof, now, 'not_verified') }
  const proof = [...actProof, ...(v?.proof ?? [])]
  if (!v?.ok || !(v.proof ?? []).length) return block(s, d, loop, v?.ok ? 'The check returned no proof, so the fix is not confirmed' : 'A fresh read does not show the fix holding', proof, now, 'not_verified')

  // resolved with the fresh read as evidence
  const at = now().toISOString()
  try {
    await adm(async x => {
      if (loop.case_id) await resolveCase(x, loop.case_id, { actor, verifiedBy: `${s.agentName} (fresh read)`, summary: d.title,
        evidence: v.proof.map(pr => ({ label: clip(`${pr.label}: ${pr.value}`, 300), source: 'fresh_read', observedAt: at, ...(pr.url ? { detail: { url: pr.url } } : {}) })) })
    })
  } catch (e) { log.warn('loop.resolve_failed', { case_id: loop.case_id, error: (e as Error).message.slice(0, 200) }) }
  let undoToken: string | null = null, undoId: string | null = null
  if (done.undo?.kind) {
    try {
      const u = await createUndo({ orgId: s.orgId, kind: done.undo.kind, payload: done.undo.payload ?? {}, summary: `Undo: ${d.title}`, caseId: loop.case_id, agentKey: s.agentKey, now: now() })
      undoToken = u.token; undoId = u.id
    } catch (e) { log.warn('loop.undo_failed', { error: (e as Error).message.slice(0, 200) }) }
  }
  await setLoop(loop.id, { state: 'done', last_error: null, next_retry_at: null, undo_token_id: undoId }, now())
  await tell({ ...base(s, d, caseRef), whatIDid: d.whatIDid, proof, undoToken, severity: 'info', dedupeKey: `${s.agentKey}:${s.problemKey}:${loop.id}:done` })
  return { status: 'done', verified: true, proof, mode: loop.mode, caseRef, undoToken }
}

/** The agent could not finish: case blocked (or failed after MAX_ATTEMPTS), owner told, retry scheduled. */
async function block<P>(s: LoopSpec<P>, d: { title: string; whatHappened: string; whatIDid: string[] }, loop: LoopRow, reason: string, proof: ProofItem[], now: () => Date, as: 'failed' | 'not_verified'): Promise<LoopOutcome> {
  const actor = actorOf(s.agentKey)
  const caseRef = await caseRefOf(loop.case_id)
  const attempts = loop.attempts
  const final = attempts >= MAX_ATTEMPTS
  const retryAt = final ? null : new Date(now().getTime() + retryDelayMs(attempts))
  await setLoop(loop.id, { state: final ? 'failed' : 'blocked', last_error: clip(reason, 1000), next_retry_at: retryAt?.toISOString() ?? null }, now())
  await moveCase(loop.case_id, final ? 'failed' : 'blocked', actor, final ? `${reason}. Tried ${attempts} times; this needs you.` : `${reason}. Trying again at ${retryAt!.toISOString()}.`,
    { nextCheckAt: retryAt, evidence: [{ label: clip(reason, 300), source: 'agent', observedAt: now().toISOString() }] })
  await tell({ ...base(s, d, caseRef), whatIDid: final ? [`I tried ${attempts} times and could not finish. This needs you.`, reason] : [`I could not finish yet: ${reason}`, 'I will try again on my own.'], proof, severity: 'warning',
    dedupeKey: `${s.agentKey}:${s.problemKey}:${loop.id}:${final ? 'failed' : 'blocked'}` })
  const r = retryAt?.toISOString() ?? null
  return as === 'not_verified' ? { status: 'not_verified', proof, caseRef, retryAt: r } : { status: 'failed', error: reason, caseRef, retryAt: r }
}

// ---------------------------------------------------------------- owner decisions, resume, follow-up

/** The owner approved: the loop may act. Queues loop.resume (carried out by the agent's resumer, or its next run). */
export async function approveLoop(db: Db, loopId: string, orgId: string, by: string, now = new Date()): Promise<{ status: 'approved'; jobId: string | null }> {
  const l = await db.one<LoopRow>(`update agent_loops set state = 'approved', decided_by = $3, decided_at = $4, updated_at = $4 where id = $1 and org_id = $2 and state = 'awaiting_owner' returning *`, [loopId, orgId, by.slice(0, 160), now.toISOString()])
  if (!l) throw new EngineError('not_pending', 'this action is no longer waiting for a decision')
  if (l.case_id) {
    const c = await db.one<{ status: string }>('select status from cases where id = $1', [l.case_id])
    if (c && c.status !== 'executing' && c.status !== 'resolved' && c.status !== 'cancelled') await transitionCase(db, l.case_id, { to: 'executing', actor: by, reason: `Approved by ${by}; the agent carries it out now`, approvalRequired: false, nextCheckAt: null })
  }
  const q = await enqueue({ kind: LOOP_RESUME_JOB, orgId, payload: { loopId }, idempotencyKey: `${loopId}:approved` }, db)
  return { status: 'approved', jobId: q.id }
}

/** The owner said no: nothing is done, the case is cancelled. */
export async function rejectLoop(db: Db, loopId: string, orgId: string, by: string, reason?: string, now = new Date()): Promise<{ status: 'rejected' }> {
  const l = await db.one<LoopRow>(`update agent_loops set state = 'rejected', decided_by = $3, decided_at = $4, updated_at = $4 where id = $1 and org_id = $2 and state = 'awaiting_owner' returning *`, [loopId, orgId, by.slice(0, 160), now.toISOString()])
  if (!l) throw new EngineError('not_pending', 'this action is no longer waiting for a decision')
  if (l.case_id) {
    await transitionCase(db, l.case_id, { to: 'cancelled', actor: by, reason: reason ? `You said no: ${reason.slice(0, 300)}. Nothing was done.` : 'You said no. Nothing was done.', approvalRequired: false, nextCheckAt: null })
  }
  return { status: 'rejected' }
}

/** loop.resume: rebuild the agent's spec through its resumer and run the loop (approved, or a blocked retry that is due). */
export async function resumeLoop(loopId: string, jobOrgId: string | null): Promise<Record<string, unknown>> {
  await import('./agents')
  const l = await adm(db => db.one<LoopRow>('select * from agent_loops where id = $1', [loopId]))
  if (!l) return { skipped: true, reason: 'loop not found' }
  if (jobOrgId && l.org_id !== jobOrgId) return { skipped: true, reason: 'the loop belongs to another organization' }
  if (l.state !== 'approved' && l.state !== 'blocked') return { skipped: true, reason: `the loop is ${l.state}` }
  const r = resumers.get(l.agent_key)
  if (!r) return { skipped: true, reason: 'the agent carries it out on its next run' }
  const spec = await r({ orgId: l.org_id, problemKey: l.problem_key, actionType: l.action_type, loopId: l.id })
  if (!spec) return { skipped: true, reason: 'the agent could not rebuild the action' }
  if (spec.orgId !== l.org_id || spec.problemKey !== l.problem_key || spec.agentKey !== l.agent_key) return { skipped: true, reason: 'the rebuilt action does not match the approved one' }
  const out = await adm(db => runAgentLoop(db, spec))
  return { status: out.status }
}

/**
 * The durable follow-up of a loop's case (case kind `agent_action`, run by the case.check job with its clock):
 * an owner who has not answered gets a reminder at 24 hours and the case is escalated at 72 hours; a blocked
 * loop whose retry is due is resumed.
 */
export async function followUpLoopCase(caseId: string, now: Date): Promise<void> {
  const l = await adm(db => db.one<LoopRow>(`select * from agent_loops where case_id = $1 and ${OPEN_SQL} order by created_at desc limit 1`, [caseId]))
  const setCheck = (at: Date | null) => adm(db => db.query('update cases set next_check_at = $2 where id = $1', [caseId, at?.toISOString() ?? null]))
  if (!l) { await setCheck(null); return }
  const caseRef = await caseRefOf(caseId)
  const d = { title: l.action.title ?? 'An action is waiting for you', whatHappened: l.action.whatHappened ?? '' }
  const b = { orgId: l.org_id, agentKey: l.agent_key, agentName: l.agent_name || l.agent_key, caseRef, headline: d.title, whatHappened: d.whatHappened, detailsPath: caseRef ? `/store/work/${caseRef}` : '/store/work' }
  if (l.state === 'awaiting_owner') {
    const asked = new Date(l.asked_at ?? l.created_at).getTime()
    const age = now.getTime() - asked
    if (age >= ESCALATE_AFTER_MS && !l.escalated_at) {
      await setLoop(l.id, { escalated_at: now.toISOString() }, now)
      await moveCase(caseId, 'escalated', actorOf(l.agent_key), 'No answer in 3 days: this still needs your decision', { nextCheckAt: null })
      await tell({ ...b, whatIDid: ['This has waited 3 days for your decision. Nothing has been done.', ...(l.action.whatIDid ?? [])], proof: [], severity: 'warning', dedupeKey: `${l.agent_key}:${l.problem_key}:${l.id}:escalated` })
      return
    }
    if (age >= REMIND_AFTER_MS && !l.reminded_at && !l.escalated_at) {
      await setLoop(l.id, { reminded_at: now.toISOString() }, now)
      await tell({ ...b, whatIDid: ['Reminder: this is still waiting for your decision. Nothing has been done.', ...(l.action.whatIDid ?? [])], proof: [], severity: 'action', dedupeKey: `${l.agent_key}:${l.problem_key}:${l.id}:reminder` })
      await setCheck(new Date(asked + ESCALATE_AFTER_MS))
      return
    }
    await setCheck(l.escalated_at ? null : new Date(asked + (l.reminded_at ? ESCALATE_AFTER_MS : REMIND_AFTER_MS)))
    return
  }
  if (l.state === 'blocked' || l.state === 'approved') {
    if (l.state === 'blocked' && l.next_retry_at && new Date(l.next_retry_at) > now) { await setCheck(new Date(l.next_retry_at)); return }
    if (resumers.has(l.agent_key)) {
          await enqueue({ kind: LOOP_RESUME_JOB, orgId: l.org_id, payload: { loopId: l.id }, idempotencyKey: `${l.id}:${l.state}:${l.attempts}` })
    }
    await setCheck(null)
    return
  }
  await setCheck(null)
}

// the loop's case kind: its durable check is the follow-up above
registerCaseKind(LOOP_CASE_KIND, (c, now) => followUpLoopCase(c.id, now))
