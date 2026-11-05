/**
 * Resolution Engine. A case is one business problem carried from detection to a verified outcome:
 *
 *   detected -> investigating -> proposed -> awaiting_approval -> executing -> waiting_external -> verifying -> resolved
 *                                   \-> blocked | failed | cancelled | escalated (from any open status)
 *
 * Rules the engine enforces, whichever agent or suite drives the case:
 *  - one open case per problem (org + dedupe key): detecting it again records a `redetected` event;
 *  - only the transitions in TRANSITIONS are allowed; terminal cases (resolved, cancelled) never reopen —
 *    the same problem seen again opens a new case;
 *  - an action is not a resolution: `resolveCase` needs verification evidence (what was observed, where, when);
 *    sending a message moves a case to `waiting_external`, never to `resolved`;
 *  - handing a case to another agent changes ownership only: it grants nothing (each agent acts under its own
 *    authorization; see lib/engine/authorize.ts and lib/office/actions.ts);
 *  - every change is an append-only case event; case text from external content is stored as data.
 *
 * Cases survive restarts: the next check is a column (`next_check_at`), and due cases are checked by a
 * durable job (`case.check`) through the kind's registered checker.
 *
 * All functions take a service-role `Db` (writes) after the caller has checked the organization; reads for
 * users go through RLS (`listCases`, `getCase` accept any Db and filter by org).
 */
import type { Db } from '../db'
import { EngineError } from '../engine/errors'
import { audit } from '../engine/audit'

export const CASE_STATUSES = ['detected', 'investigating', 'proposed', 'awaiting_approval', 'executing', 'waiting_external', 'verifying', 'resolved', 'blocked', 'failed', 'cancelled', 'escalated'] as const
export type CaseStatus = (typeof CASE_STATUSES)[number]
export const OPEN_STATUSES: CaseStatus[] = ['detected', 'investigating', 'proposed', 'awaiting_approval', 'executing', 'waiting_external', 'verifying', 'blocked', 'failed', 'escalated']
export const TERMINAL: CaseStatus[] = ['resolved', 'cancelled']
export type Suite = 'commerce' | 'office'
export type Priority = 'urgent' | 'high' | 'normal' | 'low'
export type AgentKind = 'engine' | 'office' | 'library'

const ATTENTION: CaseStatus[] = ['blocked', 'failed', 'cancelled', 'escalated']
/** Allowed moves. Any open status may also go to blocked, failed, cancelled or escalated. */
export const TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  detected: ['investigating', 'proposed', 'awaiting_approval', 'executing', 'waiting_external', 'verifying'],
  investigating: ['proposed', 'awaiting_approval', 'executing', 'waiting_external', 'verifying', 'detected'],
  proposed: ['awaiting_approval', 'executing', 'investigating'],
  awaiting_approval: ['executing', 'proposed', 'investigating'],
  executing: ['waiting_external', 'verifying', 'investigating', 'awaiting_approval'],
  waiting_external: ['investigating', 'verifying', 'proposed', 'awaiting_approval', 'executing'],
  verifying: ['investigating', 'waiting_external', 'executing', 'proposed'],
  blocked: ['investigating', 'proposed', 'awaiting_approval', 'executing', 'waiting_external', 'verifying'],
  failed: ['investigating', 'proposed', 'awaiting_approval', 'executing', 'verifying'],
  escalated: ['investigating', 'proposed', 'awaiting_approval', 'executing', 'waiting_external', 'verifying'],
  resolved: [],
  cancelled: [],
}
export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  if (from === to) return false
  if (TERMINAL.includes(from)) return false
  if (to === 'resolved') return false // only resolveCase, with verification evidence
  if (ATTENTION.includes(to)) return true
  return TRANSITIONS[from].includes(to)
}

export type Evidence = { label: string; source: string; observedAt: string; detail?: Record<string, unknown>; ref?: { type: string; id: string } }
export type CaseRecord = { type: string; id: string; label?: string }
export type Verification = { criteria: string; rule?: Record<string, unknown> }

export type CaseRow = {
  id: string; org_id: string; ref: string; suite: Suite; kind: string; source_app: string; dedupe_key: string
  title: string; problem: string; why_it_matters: string | null; priority: Priority; status: CaseStatus; status_reason: string | null
  agent_kind: AgentKind | null; agent_ref: string | null; next_action: string | null; approval_required: boolean
  next_check_at: string | null; deadline_at: string | null; verification: Verification | Record<string, never>
  outcome: { summary: string; evidence: Evidence[]; verifiedBy: string; verifiedAt: string } | null
  evidence: Evidence[]; records: CaseRecord[]; attempts: number; opened_at: string; closed_at: string | null; updated_at: string
}
export type CaseEvent = { id: string; case_id: string; at: string; actor: string; type: string; from_status: string | null; to_status: string | null; summary: string; detail: Record<string, unknown>; ref_type: string | null; ref_id: string | null }

const clip = (s: string | null | undefined, n: number) => (s == null ? null : String(s).replace(/\u0000/g, '').slice(0, n))
function cleanEvidence(e: Evidence): Evidence {
  if (!e || typeof e.label !== 'string' || typeof e.source !== 'string') throw new EngineError('invalid_input', 'evidence needs a label and a source')
  const at = new Date(e.observedAt)
  if (Number.isNaN(at.getTime())) throw new EngineError('invalid_input', 'evidence needs the time it was observed')
  return { label: clip(e.label, 300)!, source: clip(e.source, 80)!, observedAt: at.toISOString(), ...(e.detail ? { detail: e.detail } : {}), ...(e.ref ? { ref: { type: clip(e.ref.type, 40)!, id: clip(e.ref.id, 120)! } } : {}) }
}

async function event(db: Db, c: Pick<CaseRow, 'id' | 'org_id'>, e: { actor: string; type: string; from?: CaseStatus | null; to?: CaseStatus | null; summary: string; detail?: Record<string, unknown>; ref?: { type: string; id: string } | null }) {
  await db.query(`insert into case_events (case_id, org_id, actor, type, from_status, to_status, summary, detail, ref_type, ref_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [c.id, c.org_id, clip(e.actor, 160), e.type, e.from ?? null, e.to ?? null, clip(e.summary, 1000), JSON.stringify(e.detail ?? {}), e.ref?.type ?? null, e.ref ? clip(e.ref.id, 120) : null])
}

export type OpenCaseInput = {
  orgId: string; suite: Suite; kind: string; sourceApp: string; dedupeKey: string
  title: string; problem: string; whyItMatters?: string | null; priority?: Priority
  agent?: { kind: AgentKind; ref: string } | null
  evidence?: Evidence[]; records?: CaseRecord[]; verification: Verification
  nextAction?: string | null; nextCheckAt?: Date | null; deadlineAt?: Date | null; actor: string
}

/**
 * Open a case for a problem, or return the open case for the same problem (re-detection adds new evidence
 * and a `redetected` event, never a second case). Records are linked so sources can find the case later.
 */
export async function openCase(db: Db, i: OpenCaseInput): Promise<{ case: CaseRow; created: boolean }> {
  if (!i.verification?.criteria?.trim()) throw new EngineError('invalid_input', 'a case needs its verification criteria: what must be observed for it to count as resolved')
  const evidence = (i.evidence ?? []).map(cleanEvidence)
  const records = (i.records ?? []).slice(0, 50).map(r => ({ type: clip(r.type, 40)!, id: clip(r.id, 120)!, ...(r.label ? { label: clip(r.label, 200)! } : {}) }))
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [`case:${i.orgId}:${i.dedupeKey}`])
  const existing = await db.one<CaseRow>(`select * from cases where org_id = $1 and dedupe_key = $2 and status not in ('resolved','cancelled') for update`, [i.orgId, i.dedupeKey])
  if (existing) {
    if (evidence.length) await db.query(`update cases set evidence = (evidence || $2::jsonb) where id = $1`, [existing.id, JSON.stringify(evidence)])
    await event(db, existing, { actor: i.actor, type: 'redetected', summary: 'Seen again', detail: { evidence: evidence.length } })
    await linkRecords(db, existing, records)
    return { case: (await db.one<CaseRow>('select * from cases where id = $1', [existing.id]))!, created: false }
  }
  const c = (await db.one<CaseRow>(
    `insert into cases (org_id, suite, kind, source_app, dedupe_key, title, problem, why_it_matters, priority, agent_kind, agent_ref, next_action, next_check_at, deadline_at, verification, evidence, records)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
    [i.orgId, i.suite, i.kind, i.sourceApp, clip(i.dedupeKey, 300), clip(i.title, 300), clip(i.problem, 4000), clip(i.whyItMatters, 2000), i.priority ?? 'normal',
      i.agent?.kind ?? null, i.agent ? clip(i.agent.ref, 120) : null, clip(i.nextAction, 1000), i.nextCheckAt?.toISOString() ?? null, i.deadlineAt?.toISOString() ?? null,
      JSON.stringify({ criteria: clip(i.verification.criteria, 1000), ...(i.verification.rule ? { rule: i.verification.rule } : {}) }), JSON.stringify(evidence), JSON.stringify(records)]))!
  await event(db, c, { actor: i.actor, type: 'opened', to: 'detected', summary: c.title, detail: { kind: c.kind, source: c.source_app } })
  await linkRecords(db, c, records)
  await audit(db, { orgId: c.org_id, entityType: 'case', entityId: c.id, event: 'case.opened', actor: i.actor, detail: { ref: c.ref, kind: c.kind } })
  return { case: c, created: true }
}

async function linkRecords(db: Db, c: Pick<CaseRow, 'id' | 'org_id'>, records: CaseRecord[]) {
  for (const r of records) await db.query(`insert into case_links (case_id, org_id, ref_type, ref_id) values ($1,$2,$3,$4) on conflict do nothing`, [c.id, c.org_id, r.type, r.id])
}

/** Link another record (an email sent, an Office action, an execution) to a case. */
export async function linkRecord(db: Db, caseId: string, r: CaseRecord, actor: string) {
  const c = await lockCase(db, caseId)
  await linkRecords(db, c, [r])
  await event(db, c, { actor, type: 'link', summary: `Linked ${r.label ?? r.type}`, ref: { type: r.type, id: r.id } })
}

async function lockCase(db: Db, caseId: string, orgId?: string): Promise<CaseRow> {
  const c = await db.one<CaseRow>('select * from cases where id = $1 for update', [caseId])
  if (!c || (orgId && c.org_id !== orgId)) throw new EngineError('not_found', 'case not found')
  return c
}

/** The open case linked to an underlying record (e.g. the email message an agent just sent), if any. */
export async function caseForRecord(db: Db, orgId: string, refType: string, refId: string): Promise<CaseRow | null> {
  return db.one<CaseRow>(`select c.* from case_links l join cases c on c.id = l.case_id where l.org_id = $1 and l.ref_type = $2 and l.ref_id = $3
    order by (c.status in ('resolved','cancelled')), c.opened_at desc limit 1`, [orgId, refType, refId])
}

export type TransitionInput = {
  to: CaseStatus; actor: string; reason: string
  nextAction?: string | null; nextCheckAt?: Date | null; approvalRequired?: boolean
  evidence?: Evidence[]; ref?: { type: string; id: string } | null
}

/** Move a case along its lifecycle. Refuses transitions the lifecycle does not allow, and terminal cases. */
export async function transitionCase(db: Db, caseId: string, t: TransitionInput, opts: { orgId?: string } = {}): Promise<CaseRow> {
  const c = await lockCase(db, caseId, opts.orgId)
  if (!canTransition(c.status, t.to)) throw new EngineError('invalid_input', `a case cannot go from ${c.status} to ${t.to}${t.to === 'resolved' ? ' without verification (use resolveCase)' : ''}`)
  const evidence = (t.evidence ?? []).map(cleanEvidence)
  const r = (await db.one<CaseRow>(
    `update cases set status = $2, status_reason = $3, next_action = case when $4::boolean then $5 else next_action end,
       next_check_at = case when $6::boolean then $7::timestamptz else next_check_at end,
       approval_required = coalesce($8, approval_required), evidence = evidence || $9::jsonb,
       closed_at = case when $2 = 'cancelled' then now() else closed_at end,
       attempts = attempts + case when $2 in ('executing') then 1 else 0 end
     where id = $1 returning *`,
    [c.id, t.to, clip(t.reason, 1000), t.nextAction !== undefined, clip(t.nextAction ?? null, 1000), t.nextCheckAt !== undefined, t.nextCheckAt?.toISOString() ?? null,
      t.approvalRequired ?? null, JSON.stringify(evidence)]))!
  await event(db, c, { actor: t.actor, type: 'status', from: c.status, to: t.to, summary: t.reason, detail: evidence.length ? { evidence } : {}, ref: t.ref ?? null })
  return r
}

/** Record an action an agent took (an email sent, a correction applied). An action never resolves a case. */
export async function recordAction(db: Db, caseId: string, a: { actor: string; summary: string; ref?: { type: string; id: string } | null; detail?: Record<string, unknown> }) {
  const c = await lockCase(db, caseId)
  if (TERMINAL.includes(c.status)) throw new EngineError('invalid_input', `the case is ${c.status}`)
  await event(db, c, { actor: a.actor, type: 'action', summary: a.summary, detail: a.detail ?? {}, ref: a.ref ?? null })
  if (a.ref) await linkRecords(db, c, [{ type: a.ref.type, id: a.ref.id }])
}

export async function addEvidence(db: Db, caseId: string, e: Evidence, actor: string) {
  const c = await lockCase(db, caseId)
  const ev = cleanEvidence(e)
  await db.query(`update cases set evidence = evidence || $2::jsonb where id = $1`, [c.id, JSON.stringify([ev])])
  await event(db, c, { actor, type: 'evidence', summary: ev.label, detail: { evidence: ev }, ref: ev.ref ?? null })
}

export async function addNote(db: Db, caseId: string, note: string, actor: string) {
  const c = await lockCase(db, caseId)
  await event(db, c, { actor, type: 'note', summary: clip(note, 1000)! })
}

/**
 * Close a case as resolved. Needs at least one piece of verification evidence observed in a source of truth
 * (a fresh read of the store, the CRM, the calendar, the accounting system, a received reply) — the rule in
 * the brief: an action is not a resolution. Allowed from `verifying` (normally) or any open status when the
 * verifier observed the outcome directly.
 */
export async function resolveCase(db: Db, caseId: string, v: { actor: string; summary: string; evidence: Evidence[]; verifiedBy: string }, opts: { orgId?: string } = {}): Promise<CaseRow> {
  const c = await lockCase(db, caseId, opts.orgId)
  if (TERMINAL.includes(c.status)) throw new EngineError('not_pending', `the case is already ${c.status}`)
  const evidence = (v.evidence ?? []).map(cleanEvidence)
  if (!evidence.length) throw new EngineError('invalid_input', 'a case is resolved only with verification evidence (what was observed, where and when)')
  if (!v.verifiedBy?.trim()) throw new EngineError('invalid_input', 'name what verified the outcome')
  const outcome = { summary: clip(v.summary, 1000), evidence, verifiedBy: clip(v.verifiedBy, 160), verifiedAt: new Date().toISOString() }
  const r = (await db.one<CaseRow>(`update cases set status = 'resolved', status_reason = $2, outcome = $3, next_check_at = null, next_action = null, approval_required = false, closed_at = now(),
     evidence = evidence || $4::jsonb where id = $1 returning *`, [c.id, clip(v.summary, 1000), JSON.stringify(outcome), JSON.stringify(evidence)]))!
  await event(db, c, { actor: v.actor, type: 'verification', from: c.status, to: 'resolved', summary: v.summary, detail: { outcome } })
  await audit(db, { orgId: c.org_id, entityType: 'case', entityId: c.id, event: 'case.resolved', actor: v.actor, detail: { ref: c.ref, verified_by: outcome.verifiedBy } })
  return r
}

/** Hand a case to another agent of the same organization. Ownership only: no permission moves with it. */
export async function handOffCase(db: Db, caseId: string, to: { kind: AgentKind; ref: string }, h: { actor: string; reason: string }) {
  const c = await lockCase(db, caseId)
  if (TERMINAL.includes(c.status)) throw new EngineError('invalid_input', `the case is ${c.status}`)
  const owner = to.kind === 'engine' ? await db.one<{ org_id: string }>('select org_id from agents where id::text = $1', [to.ref])
    : to.kind === 'office' ? await db.one<{ org_id: string }>('select org_id from office_agents where id::text = $1', [to.ref])
    : await db.one<{ org_id: string }>('select org_id from library_switches where org_id = $1 and agent_key = $2', [c.org_id, to.ref])
  if (!owner || owner.org_id !== c.org_id) throw new EngineError('forbidden', 'a case can be handed only to an agent of the same organization')
  await db.query('update cases set agent_kind = $2, agent_ref = $3 where id = $1', [c.id, to.kind, to.ref])
  await event(db, c, { actor: h.actor, type: 'handoff', summary: h.reason, detail: { from: c.agent_kind ? { kind: c.agent_kind, ref: c.agent_ref } : null, to, grants: 'none: the new owner acts only under its own authorization' } })
}

// ---------------------------------------------------------------- reads (RLS or service role; always org-filtered)

export type CaseView = 'in_progress' | 'needs_approval' | 'completed' | 'attention' | 'all'
const VIEW_SQL: Record<CaseView, string> = {
  in_progress: `status in ('detected','investigating','proposed','executing','waiting_external','verifying')`,
  needs_approval: `status = 'awaiting_approval'`,
  completed: `status = 'resolved'`,
  attention: `status in ('blocked','failed','escalated')`,
  all: 'true',
}
export async function listCases(db: Db, orgId: string, f: { view?: CaseView; suite?: Suite; kind?: string; limit?: number; before?: string } = {}): Promise<CaseRow[]> {
  const where = [`org_id = $1`, VIEW_SQL[f.view ?? 'all']]
  const params: unknown[] = [orgId]
  if (f.suite) { params.push(f.suite); where.push(`suite = $${params.length}`) }
  if (f.kind) { params.push(f.kind); where.push(`kind = $${params.length}`) }
  if (f.before) { params.push(f.before); where.push(`updated_at < $${params.length}::timestamptz`) }
  params.push(Math.min(Math.max(f.limit ?? 50, 1), 200))
  return db.query<CaseRow>(`select * from cases where ${where.join(' and ')} order by updated_at desc limit $${params.length}`, params)
}
export async function getCase(db: Db, orgId: string, idOrRef: string): Promise<{ case: CaseRow; events: CaseEvent[] } | null> {
  const c = await db.one<CaseRow>(`select * from cases where org_id = $1 and (ref = $2 or id::text = $2)`, [orgId, idOrRef])
  if (!c) return null
  const events = await db.query<CaseEvent>(`select id::text, case_id, at, actor, type, from_status, to_status, summary, detail, ref_type, ref_id from case_events where case_id = $1 order by case_events.id`, [c.id])
  return { case: c, events }
}
export async function caseCounts(db: Db, orgId: string) {
  const r = await db.one<Record<string, number>>(`select
      count(*) filter (where ${VIEW_SQL.in_progress})::int as in_progress, count(*) filter (where ${VIEW_SQL.needs_approval})::int as needs_approval,
      count(*) filter (where ${VIEW_SQL.completed})::int as completed, count(*) filter (where ${VIEW_SQL.attention})::int as attention,
      count(*)::int as total, count(*) filter (where status = 'resolved' and closed_at > now() - interval '30 days')::int as resolved_30d
    from cases where org_id = $1`, [orgId])
  return r ?? { in_progress: 0, needs_approval: 0, completed: 0, attention: 0, total: 0, resolved_30d: 0 }
}

// ---------------------------------------------------------------- kinds and durable checks

/**
 * A case kind's checker looks at the world again (a fresh read of the source of truth) and moves the case:
 * resolve it with evidence, keep waiting (new next check), escalate, or do nothing. Registered by each domain
 * (commerce supplier exceptions, Office follow-ups, receivables ...). Unknown kinds are left alone.
 */
export type CaseChecker = (c: CaseRow, now: Date) => Promise<void>
const checkers = new Map<string, CaseChecker>()
export function registerCaseKind(kind: string, check: CaseChecker) { checkers.set(kind, check) }
export const registeredCaseKinds = () => [...checkers.keys()]

/** Due cases (next_check_at passed), oldest first; each is checked by its kind, once, under its own transaction. */
export async function dueCases(db: Db, now: Date, limit = 50): Promise<Pick<CaseRow, 'id' | 'org_id' | 'kind'>[]> {
  return db.query(`select id, org_id, kind from cases where next_check_at <= $1 and status not in ('resolved','cancelled','failed') order by next_check_at limit $2`, [now.toISOString(), limit])
}
export async function runCaseCheck(caseId: string, now = new Date()): Promise<{ status: CaseStatus | 'skipped'; reason?: string }> {
  const { admin } = await import('../db')
  const c = await admin(db => db.one<CaseRow>('select * from cases where id = $1', [caseId]))
  if (!c || TERMINAL.includes(c.status)) return { status: 'skipped', reason: 'closed or missing' }
  if (c.next_check_at && new Date(c.next_check_at) > now) return { status: 'skipped', reason: 'not due' }
  const check = checkers.get(c.kind)
  if (!check) {
    await admin(db => db.query('update cases set next_check_at = null where id = $1', [c.id]))
    return { status: 'skipped', reason: `no checker for ${c.kind}` }
  }
  // Claim the check before running it (reliability fix R-1, tests/reliability/runtime.test.ts): two case.check
  // jobs for one case (queued for two due times by overlapping sweeps) used to run the checker twice at once.
  // The claim moves next_check_at forward one hour atomically, so only one worker wins; a checker that neither
  // moves nor reschedules the case is then checked again in an hour (as before). A checker that throws gives
  // the claim back, so the job's retry runs it.
  const lease = new Date(now.getTime() + 3600e3).toISOString()
  const claimed = await admin(db => db.one<{ id: string }>(`update cases set next_check_at = $3 where id = $1 and (next_check_at is null or next_check_at <= $2::timestamptz) and status not in ('resolved','cancelled') returning id`, [c.id, now.toISOString(), lease]))
  if (!claimed) return { status: 'skipped', reason: 'already being checked' }
  try {
    await check(c, now)
  } catch (e) {
    await admin(db => db.query('update cases set next_check_at = $2 where id = $1 and next_check_at = $3', [c.id, c.next_check_at, lease]))
    throw e
  }
  // a case that had no scheduled check and was not rescheduled by its checker keeps having none
  if (c.next_check_at === null) await admin(db => db.query('update cases set next_check_at = null where id = $1 and next_check_at = $2', [c.id, lease]))
  const after = await admin(db => db.one<{ status: CaseStatus }>('select status from cases where id = $1', [c.id]))
  return { status: after?.status ?? 'skipped' }
}
