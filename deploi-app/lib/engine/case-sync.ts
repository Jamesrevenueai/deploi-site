/**
 * Case adapter for the store correction engine (Stock Guardian, Price Keeper and the other correction agents,
 * the Inventory Watcher and Store Health Checker watch checks, and the merchant's own store checks).
 *
 * The engine's records are the source of truth; the case (lib/cases) follows them through the one lifecycle,
 * one allowed transition at a time (lib/office/case-sync.ts#moveCase):
 *
 *   issue found                 -> case opened (one per store + check + resource: the issue fingerprint)
 *   proposal waiting            -> `proposed` (drafts-only agent) or `awaiting_approval` (the tier needs approval)
 *   approved / being written    -> `executing`, the execution linked and the change recorded as an action
 *   verified by a fresh read    -> `resolved`, the verified read is the evidence
 *   gone on a fresh read        -> `resolved`, "no longer present on a fresh read" is the evidence
 *   stale / expired / superseded-> `investigating` with the reason (the agent re-checks on its next run)
 *   refused / blocked           -> `blocked` with the reason; a failed write -> `failed`
 *   dismissed / exempted        -> `cancelled` with the merchant's reason (never a resolution)
 *   check turned off            -> `cancelled`: the problem is no longer watched, so it was not verified
 *
 * Nothing here writes to a store or changes an engine record: the case is the customer's view of the work.
 */
import { admin, type Db } from '../db'
import { log } from '../log'
import { getCheck, allChecks } from './registry'
import { caseForRecord, openCase, registerCaseKind, resolveCase, TERMINAL, transitionCase, type CaseRow, type Evidence, type Priority } from '../cases'
import { moveCase, ensureLink, ensureActionRecorded, type CaseTarget } from '../office/case-sync'
import type { IssueRow } from './scan'
import type { ProposalRow } from './proposals'

export const ENGINE_CASE_ACTOR = 'system:engine-cases'
const RECHECK_MS = 6 * 3600e3
const PRIORITY: Record<string, Priority> = { high: 'high', medium: 'normal', low: 'low' }

/** The case kind for an issue: its check key in case-kind form (shopify.oversell_policy -> shopify_oversell_policy). */
export function issueCaseKind(checkKey: string): string {
  const k = checkKey.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
  return /^[a-z]/.test(k) && k.length >= 3 ? k : `store_${k}`.slice(0, 60)
}
/** One open case per store + check + resource (the issue fingerprint is the check key and the resource). */
export const issueDedupeKey = (connectionId: string, fingerprint: string) => `store:${connectionId}:${fingerprint}`.slice(0, 300)

type ExecRow = { id: string; status: string; status_reason: string | null; verification: { field?: string; expected?: unknown; observed?: unknown; readAt?: string | null } | null
  precheck: { fetchedAt?: string; current?: unknown } | null; before_value: unknown; after_value: unknown; finished_at: string | null; verified_at: string | null; created_at: string }

const show = (v: unknown) => (v === null || v === undefined ? 'empty' : typeof v === 'string' ? `"${v.slice(0, 80)}"` : JSON.stringify(v).slice(0, 80))
const clip = (s: string, n = 1000) => s.slice(0, n)

/** Open the case for an open issue (or return the open case already linked to it). */
async function caseOf(db: Db, i: IssueRow, actor: string): Promise<CaseRow | null> {
  const linked = await caseForRecord(db, i.org_id, 'issue', i.id)
  if (linked && !TERMINAL.includes(linked.status)) return linked
  if (i.status !== 'open' && i.status !== 'needs_review') return linked
  const check = getCheck(i.check_key)
  const label = i.resource_label ?? i.resource_id
  const ev = i.evidence as { summary?: string; fetchedAt?: string }
  const r = await openCase(db, {
    orgId: i.org_id, suite: 'commerce', kind: issueCaseKind(i.check_key), sourceApp: i.platform, dedupeKey: issueDedupeKey(i.connection_id, i.fingerprint),
    title: `${check?.title ?? i.check_key}: ${label}`.slice(0, 300), problem: ev.summary ?? `${check?.title ?? i.check_key} on ${label}.`,
    whyItMatters: check?.whyItIsAnError ?? null, priority: PRIORITY[i.severity] ?? 'normal',
    agent: (i as IssueRow & { agent_id?: string | null }).agent_id ? { kind: 'engine', ref: (i as IssueRow & { agent_id: string }).agent_id } : null,
    evidence: [{ label: ev.summary ?? check?.title ?? i.check_key, source: i.platform, observedAt: ev.fetchedAt && !Number.isNaN(new Date(ev.fetchedAt).getTime()) ? ev.fetchedAt : i.last_seen_at, detail: { checkKey: i.check_key, severity: i.severity }, ref: { type: 'issue', id: i.id } }],
    records: [{ type: 'issue', id: i.id, label: check?.title ?? i.check_key }, { type: 'store_resource', id: i.resource_id, label: label.slice(0, 200) }],
    verification: { criteria: 'A fresh read of the store no longer shows this problem', rule: { type: 'store_issue_cleared', connectionId: i.connection_id, fingerprint: i.fingerprint } },
    nextCheckAt: new Date(Date.now() + RECHECK_MS), actor,
  })
  return r.case
}

type Outcome =
  | { kind: 'resolve'; summary: string; verifiedBy: string; evidence: Evidence[]; viaExecution: boolean }
  | { kind: 'cancel'; reason: string }
  | { kind: 'move'; target: CaseTarget }
  | { kind: 'none' }

function outcomeFor(i: IssueRow, p: ProposalRow | null, e: ExecRow | null, mode: string | null, opts: { scanId?: string | null; now: Date }): Outcome {
  const later = new Date(opts.now.getTime() + RECHECK_MS)
  if (i.status === 'resolved') {
    const at = i.resolved_at ?? opts.now.toISOString()
    if (i.resolution === 'verified_fix' && e?.status === 'verified') {
      const v = e.verification ?? {}
      return { kind: 'resolve', viaExecution: true, verifiedBy: `${i.platform} read after the change`, summary: 'Changed by Deploi and confirmed by a fresh read of the store',
        evidence: [{ label: `A fresh read shows ${v.field ?? 'the field'} = ${show(v.observed)} (expected ${show(v.expected)})`, source: i.platform, observedAt: v.readAt ?? e.verified_at ?? e.finished_at ?? at, detail: { field: v.field, expected: v.expected, observed: v.observed }, ref: { type: 'execution', id: e.id } }] }
    }
    if (i.status_reason === 'rule turned off') return { kind: 'cancel', reason: 'The check was turned off, so this problem is no longer watched. It was not verified as fixed.' }
    if (i.status_reason && /deleted/i.test(i.status_reason)) return { kind: 'cancel', reason: `Closed: ${i.status_reason}. Nothing was left to fix.` }
    if (i.status_reason === 'already corrected outside Deploi' && e) {
      return { kind: 'resolve', viaExecution: false, verifiedBy: `${i.platform} read before writing`, summary: 'Already corrected outside Deploi: a fresh read before writing showed the proposed value',
        evidence: [{ label: `A fresh read shows ${show(e.precheck?.current)}, the proposed value`, source: i.platform, observedAt: e.precheck?.fetchedAt ?? e.finished_at ?? at, detail: { current: e.precheck?.current }, ref: { type: 'execution', id: e.id } }] }
    }
    return { kind: 'resolve', viaExecution: false, verifiedBy: `${i.platform} read`, summary: 'No longer present on a fresh read of the store',
      evidence: [{ label: 'The problem is no longer present on a fresh read of the store', source: i.platform, observedAt: at, detail: { resolution: i.resolution, reason: i.status_reason }, ...(opts.scanId ? { ref: { type: 'scan', id: opts.scanId } } : {}) }] }
  }
  if (i.status === 'dismissed') return { kind: 'cancel', reason: `Closed by you: ${i.status_reason ?? 'dismissed'}` }
  if (i.status === 'needs_review') {
    const reason = i.status_reason === 'conflicting_agent' ? 'Two agents found different changes for the same record. A person needs to decide; neither change is made.'
      : i.status_reason === 'reverted_after_fix' ? 'Deploi fixed this and it was changed back. Deploi does not propose it again until you confirm.'
      : `Needs your review${i.status_reason ? `: ${i.status_reason}` : ''}`
    return { kind: 'move', target: { status: 'blocked', reason, nextAction: 'Open the issue and decide.', nextCheckAt: later } }
  }
  const ev = i.evidence as { summary?: string; humanAction?: string | null }
  if (i.kind === 'needs_person') return { kind: 'move', target: { status: 'investigating', reason: `Needs a person: ${ev.summary ?? 'see the issue'}`, nextAction: ev.humanAction ?? 'Look at the item in your store.', nextCheckAt: later } }
  if (!p) return { kind: 'none' }
  const ref = { type: 'proposal', id: p.id }
  switch (p.status) {
    case 'pending_approval':
      if (mode === 'draft') return { kind: 'move', target: { status: 'proposed', reason: 'Fix proposed as a draft: this agent only shows the exact change; it may not make it', nextAction: 'Read the change. To let the agent make it, give it permission to make changes you approve.', nextCheckAt: later, ref } }
      return { kind: 'move', target: { status: 'awaiting_approval', reason: clip(p.status_reason && !/^draft:/.test(p.status_reason) ? p.status_reason : 'The exact change waits for your approval'), nextAction: 'Approve or decline the exact change in Needs My Approval.', nextCheckAt: later, ref } }
    case 'approved': case 'executing': case 'applied':
      return { kind: 'move', target: { status: 'executing', reason: p.status === 'approved' ? 'Approved: the change is being made' : 'The change is being made and then checked with a fresh read', nextAction: null, nextCheckAt: later, ref: e ? { type: 'execution', id: e.id } : ref } }
    case 'stale': case 'expired': case 'superseded':
      return { kind: 'move', target: { status: 'investigating', reason: clip(`The proposed change went ${p.status === 'superseded' ? 'out of date' : p.status}: ${p.status_reason ?? 'the records changed'}. The agent checks the store again on its next run.`), nextAction: 'Nothing to do: a new exact change is proposed if the problem is still there.', nextCheckAt: later, ref } }
    case 'blocked':
      return { kind: 'move', target: { status: 'blocked', reason: clip(`Refused before anything was written: ${p.status_reason ?? e?.status_reason ?? 'blocked'}`), nextAction: 'Fix the reason shown, then run the agent again.', nextCheckAt: later, ref } }
    case 'failed':
      return { kind: 'move', target: { status: 'failed', reason: clip(`The change did not work: ${e?.status_reason ?? p.status_reason ?? 'failed'}`), nextAction: 'Retry it from the work log, or fix it in your store.', nextCheckAt: later, ref: e ? { type: 'execution', id: e.id } : ref } }
    default:
      return { kind: 'none' }
  }
}

/**
 * Bring an issue's case up to date with the issue, its latest proposal and execution. Safe to call any
 * number of times: a case that already shows the right status is left alone (no duplicate events).
 */
export async function syncIssueCase(issueId: string, opts: { actor?: string; scanId?: string | null; now?: Date } = {}): Promise<CaseRow | null> {
  // the case is a view of the engine's records: a failure here never undoes or fails the engine's own step
  try { return await syncIssueCaseSteps(issueId, opts) } catch (err) {
    log.error('engine.case_sync_failed', { issue_id: issueId, error: (err as Error).message })
    return null
  }
}

async function syncIssueCaseSteps(issueId: string, opts: { actor?: string; scanId?: string | null; now?: Date }): Promise<CaseRow | null> {
  const now = opts.now ?? new Date()
  const actor = opts.actor ?? ENGINE_CASE_ACTOR
  const ctx = await admin(async db => {
    const i = await db.one<IssueRow & { agent_id: string | null }>('select * from issues where id = $1', [issueId])
    if (!i) return null
    const p = await db.one<ProposalRow>('select * from proposals where issue_id = $1 order by created_at desc limit 1', [i.id])
    const e = p ? await db.one<ExecRow>('select id, status, status_reason, verification, precheck, before_value, after_value, finished_at, verified_at, started_at as created_at from executions where proposal_id = $1 order by started_at desc nulls last, updated_at desc limit 1', [p.id]) : null
    const mode = p?.agent_id ? (await db.one<{ mode: string | null }>(`select ap.policy->>'approvalMode' as mode from agents a left join agent_policies ap on ap.id = a.active_policy_id where a.id = $1`, [p.agent_id]))?.mode ?? null : null
    const c = await caseOf(db, i, actor)
    return { i, p, e, mode, c }
  })
  if (!ctx?.c) return null
  const { i, p, e, mode } = ctx
  let c = ctx.c
  if (TERMINAL.includes(c.status)) return c
  if (p) await ensureLink(c.id, { type: 'proposal', id: p.id, label: p.target_label ?? p.action_key }, actor)
  if (e) {
    await ensureLink(c.id, { type: 'execution', id: e.id, label: 'Store change' }, actor)
    if (['applied', 'verified', 'verification_failed', 'unknown'].includes(e.status) && p) {
      const ch = p.change as { field?: string; from?: unknown; to?: unknown }
      await ensureActionRecorded(c.id, { summary: `Wrote ${ch.field ?? 'the field'} on ${p.target_label ?? p.target_id}: ${show(ch.from)} to ${show(ch.to)}`, ref: { type: 'store_write', id: e.id }, detail: { execution_id: e.id, status: e.status } }, actor)
    }
  }
  const o = outcomeFor(i, p, e, mode, { scanId: opts.scanId ?? null, now })
  try {
    if (o.kind === 'resolve') {
      // the history shows the write before its verification
      if (o.viaExecution && !['executing', 'verifying'].includes(c.status)) c = (await moveCase(c.id, { status: 'executing', reason: 'The approved change was made', ref: e ? { type: 'execution', id: e.id } : null }, actor)) ?? c
      if (o.viaExecution && c.status === 'executing') c = (await moveCase(c.id, { status: 'verifying', reason: 'Checking the change with a fresh read of the store' }, actor)) ?? c
      return await admin(db => resolveCase(db, c.id, { actor, summary: o.summary, verifiedBy: o.verifiedBy, evidence: o.evidence }))
    }
    if (o.kind === 'cancel') return await admin(db => transitionCase(db, c.id, { to: 'cancelled', actor, reason: o.reason, nextCheckAt: null }))
    if (o.kind === 'move') {
      if (c.status === o.target.status && c.status_reason === o.target.reason.slice(0, 1000)) {
        await admin(db => db.query('update cases set next_check_at = $2 where id = $1', [c.id, o.target.nextCheckAt?.toISOString() ?? null]))
        return c
      }
      return await moveCase(c.id, o.target, actor)
    }
    return c
  } catch (err) {
    log.error('engine.case_sync_failed', { case_id: c.id, issue_id: i.id, error: (err as Error).message })
    return c
  }
}

/** Sync the cases of every issue a scan touched (opened, seen, resolved, or whose proposal changed). */
export async function syncScanCases(connectionId: string, opts: { scanId: string; since: Date; actor?: string; agentId?: string | null }): Promise<number> {
  const ids = await admin(db => db.query<{ id: string }>(
    `select i.id from issues i where i.connection_id = $1 and ($4::boolean = false or i.agent_id is not distinct from $5::uuid) and (i.last_scan_id = $2 or i.resolved_at >= $3
       or exists (select 1 from proposals p where p.issue_id = i.id and p.updated_at >= $3)) order by i.first_detected_at limit 2000`,
    [connectionId, opts.scanId, opts.since.toISOString(), opts.agentId !== undefined, opts.agentId ?? null]))
  for (const r of ids) await syncIssueCase(r.id, { actor: opts.actor, scanId: opts.scanId })
  return ids.length
}

/** Sync the case of a proposal's issue (after an approval, a refusal or an execution). */
export async function syncProposalCase(proposalId: string, opts: { actor?: string } = {}) {
  const p = await admin(db => db.one<{ issue_id: string }>('select issue_id from proposals where id = $1', [proposalId]))
  if (p) await syncIssueCase(p.issue_id, opts)
}

/** Sync every open-issue case of an agent (after its run decided each proposal). */
export async function syncAgentCases(agentId: string, opts: { since: Date; actor?: string }) {
  const ids = await admin(db => db.query<{ id: string }>(
    `select i.id from issues i where i.agent_id = $1 and (i.status in ('open','needs_review') or i.resolved_at >= $2 or exists (select 1 from proposals p where p.issue_id = i.id and p.updated_at >= $2)) limit 2000`,
    [agentId, opts.since.toISOString()]))
  for (const r of ids) await syncIssueCase(r.id, { actor: opts.actor })
}

/**
 * Checker for store-issue cases: re-reads the engine's records (a scan, an expiry or a decision since the
 * last check) and moves the case; resolution still needs the engine's fresh read (verified write or a scan
 * that no longer finds the problem).
 */
export async function checkIssueCase(c: CaseRow, now: Date): Promise<void> {
  const rule = (c.verification as { rule?: { connectionId?: string; fingerprint?: string } }).rule
  const later = () => admin(db => db.query('update cases set next_check_at = $2 where id = $1', [c.id, new Date(now.getTime() + 24 * 3600e3).toISOString()]))
  if (!rule?.connectionId || !rule.fingerprint) return void (await later())
  const i = await admin(db => db.one<{ id: string }>(
    `select id from issues where connection_id = $1 and fingerprint = $2 order by (status in ('open','needs_review')) desc, first_detected_at desc limit 1`, [rule.connectionId, rule.fingerprint]))
  if (!i) return void (await later())
  const after = await syncIssueCase(i.id, { now })
  if (after && !TERMINAL.includes(after.status) && (!after.next_check_at || new Date(after.next_check_at) <= now)) await later()
}

let registered = false
/** Register the checker for every store check's case kind (call after the connectors are loaded). */
export function registerEngineCaseKinds() {
  if (registered && allChecks().every(ch => registeredKinds.has(issueCaseKind(ch.key)))) return
  for (const ch of allChecks()) { registerCaseKind(issueCaseKind(ch.key), checkIssueCase); registeredKinds.add(issueCaseKind(ch.key)) }
  registered = true
}
const registeredKinds = new Set<string>()
