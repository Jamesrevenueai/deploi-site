/**
 * The Command center feeds (lib/app/contract.ts): needsYou, doneWithProof, team, hero, allowance and one agent's
 * dashboard. Read-only except that a first sight of an agent records its colour (agent_profiles). Every query is
 * bound to the actor's own organization; approvals are listed and decided through the existing unified approvals
 * registry (lib/approvals), never a second approval path.
 */
import { admin, type Db } from '../db'
import type { Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { listPendingApprovals, decideApproval, type ApprovalItem } from '../approvals'
import { isMoneyAction, knownActionTypes, modeFor } from '../autonomy'
import { agentByKey } from '../library/config'
import { APPROVAL_ONLY } from '../library/actions'
import { libraryWeek } from '../library/weekly'
import { planUsage } from '../plans/allowance'
import { entitlements, orgEntitlements } from '../plans/entitlements'
import { billingMode } from '../billing/config'
import { estimate, MORNING_MINUTES } from '../notify/morning'
import { ESTIMATE_MINUTES } from '../agents/weekly'
import { PACK_AGENTS } from '../packs/registry'
import { teamState, liveTeam, refOfCase, refOfLoop, workspaceOfRef, type AgentSource, type TeamState } from './team'
import { listInstructionsIn } from './control'
import type { AgentDashboard, AgentScope, AgentStat, AgentTask, Allowance, CommandCenter, DoneItem, Hero, NeedsYouDecision, NeedsYouItem, Proof, TeamAgent, WorkRow, Workspace } from './contract'

export const isWorkspace = (v: unknown): v is Workspace => v === 'store' || v === 'office'

/** The organization a merchant actor acts for; staff use the staff console. */
export function merchantOrg(actor: Actor): string {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff view an organization from the staff console')
  return actor.orgId
}

export function ago(iso: string, now = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}
const iso = (v: string | Date) => new Date(v).toISOString()
const str = (v: unknown) => (typeof v === 'string' ? v : '')

// ---------------------------------------------------------------- needs you

type CaseLite = { ref: string; suite: 'commerce' | 'office'; agent_kind: string | null; agent_ref: string | null; dedupe_key: string; records: { type: string; id: string }[] }

async function refsForItems(db: Db, orgId: string, st: TeamState, items: ApprovalItem[]): Promise<Map<string, { ref: string | null; workspace: Workspace; caseRef: string | null }>> {
  const loopIds = items.filter(i => i.source === 'agent_action').map(i => i.id)
  const loops = loopIds.length ? await db.query<{ id: string; agent_key: string; problem_key: string }>('select id, agent_key, problem_key from agent_loops where org_id = $1 and id = any($2::uuid[])', [orgId, loopIds]) : []
  const refs = [...new Set(items.map(i => str(i.content.case)).filter(Boolean))]
  const cases = refs.length ? await db.query<CaseLite>('select ref, suite, agent_kind, agent_ref, dedupe_key, records from cases where org_id = $1 and ref = any($2::text[])', [orgId, refs]) : []
  const out = new Map<string, { ref: string | null; workspace: Workspace; caseRef: string | null }>()
  for (const i of items) {
    const caseRef = str(i.content.case) || null
    const c = caseRef ? cases.find(x => x.ref === caseRef) : undefined
    let ref: string | null = null
    if (i.source === 'engine' || i.source === 'email') ref = i.agent?.id ? st.idx.byEngineId.get(i.agent.id) ?? `store:${i.agent.id}` : null
    else if (i.source === 'library') ref = i.agent?.name && agentByKey(i.agent.name) ? st.idx.byLibraryKey.get(i.agent.name) ?? `store:${i.agent.name}` : null
    else if (i.source === 'office') ref = i.agent?.id ? st.idx.byOfficeId.get(i.agent.id) ?? `office:${i.agent.id}` : null
    else if (i.source === 'agent_action') { const l = loops.find(x => x.id === i.id); ref = l ? refOfLoop(st.idx, l.agent_key, l.problem_key) : null }
    else if (c) ref = refOfCase(st.idx, c)
    const workspace: Workspace = ref ? workspaceOfRef(ref) : i.source === 'office' ? 'office' : c ? (c.suite === 'office' ? 'office' : 'store') : 'store'
    out.set(`${i.source}:${i.id}`, { ref, workspace, caseRef })
  }
  return out
}

function labels(i: ApprovalItem, money: boolean): { primary: string; secondary: string | null } {
  const at = str(i.content.actionType)
  const decline = i.decisions.includes('reject') ? 'Decline' : null
  if (i.source === 'email') return { primary: 'Send it', secondary: decline ? "Don't send" : null }
  if (i.source === 'engine') return { primary: i.decisions.includes('approve') ? 'Apply the change' : 'Dismiss', secondary: i.decisions.includes('approve') && decline ? 'Dismiss' : null }
  if (at === 'refund') return { primary: 'Approve refund', secondary: decline }
  if (at === 'discount') return { primary: 'Approve discount change', secondary: decline }
  if (at === 'payout_dispute') return { primary: 'Send the dispute', secondary: decline }
  if (at === 'reorder' || at === 'purchase_order' || i.source === 'purchase_orders') return { primary: 'Approve order', secondary: decline }
  if (money) return { primary: 'Approve payment', secondary: decline }
  return { primary: i.decisions.includes('approve') ? 'Approve' : 'Decline', secondary: i.decisions.includes('approve') ? decline : null }
}

function explain(i: ApprovalItem): { spotted: string; prepared: string } {
  const c = i.content
  const spotted = str(c.whatHappened) || str(c.problem) || str(c.summary) || i.why || i.title
  let prepared: string
  const will = Array.isArray(c.whatTheAgentWillDo) ? (c.whatTheAgentWillDo as unknown[]).map(str).filter(Boolean) : []
  if (will.length) prepared = will.join(' ')
  else if (i.source === 'email') prepared = `Drafted "${str(c.subject) || 'a message'}" to ${Array.isArray(c.to) ? (c.to as string[]).join(', ') : 'the recipient'}.`
  else if (i.source === 'engine') prepared = `Prepared the change: ${str(c.field)} from ${JSON.stringify(c.from)} to ${JSON.stringify(c.to)}.`
  else prepared = `Prepared: ${i.title}.`
  return { spotted, prepared: `${prepared} Nothing is done until you decide.` }
}

async function needsYouIn(db: Db, orgId: string, st: TeamState, items: ApprovalItem[], now: Date): Promise<NeedsYouItem[]> {
  const where = await refsForItems(db, orgId, st, items)
  return items.map(i => {
    const key = `${i.source}:${i.id}`
    const w = where.get(key)!
    const src = w.ref ? st.sources.find(s => s.id === w.ref) : undefined
    const money = i.content.money === true || isMoneyAction(str(i.content.actionType)) || i.source === 'purchase_orders'
    const l = labels(i, money)
    const e = explain(i)
    return {
      id: key, source: i.source, itemId: i.id,
      agent: { id: w.ref, name: src?.name ?? i.agent?.name ?? 'Your agent', color: w.ref ? st.profiles.get(w.ref)?.color ?? null : null },
      createdAt: iso(i.createdAt), ago: ago(i.createdAt, now), title: i.title, spotted: e.spotted, prepared: e.prepared, explanation: `${e.spotted} ${e.prepared}`.trim(),
      money, primaryAction: l.primary, secondaryAction: l.secondary, decisions: i.decisions.map(d => (d === 'reject' ? 'decline' as const : 'approve' as const)),
      caseRef: w.caseRef, workspace: w.workspace,
    }
  })
}

/** Pending agent requests for one side of the app, newest first (the existing approvals queue, agent loops included). */
export async function needsYou(actor: Actor, workspace: Workspace, opts: { now?: Date } = {}): Promise<NeedsYouItem[]> {
  const orgId = merchantOrg(actor)
  const now = opts.now ?? new Date()
  const { items } = await listPendingApprovals(actor, { now })
  return admin(async db => (await needsYouIn(db, orgId, await teamState(db, orgId), items, now)).filter(i => i.workspace === workspace))
}

const AMOUNT_KEYS = ['amount', 'refundAmount', 'total', 'value']
function amountOf(c: Record<string, unknown>): number | null {
  for (const src of [c, (c.payload ?? {}) as Record<string, unknown>]) for (const k of AMOUNT_KEYS) { const v = Number(src[k]); if (typeof src[k] !== 'undefined' && Number.isFinite(v)) return v }
  return null
}

/**
 * Decide one needs-you item through the existing approval logic (lib/approvals decideApproval: organization, role,
 * version, expiry and the source's own atomic checks). `amount`, when given, must equal the amount the item shows:
 * it confirms what is approved and never changes it.
 */
export async function decideNeedsYou(actor: Actor, id: string, decision: unknown, opts: { amount?: unknown; ip?: string | null; now?: Date } = {}): Promise<NeedsYouDecision> {
  merchantOrg(actor)
  if (decision !== 'approve' && decision !== 'decline') throw new EngineError('invalid_input', 'decision must be approve or decline')
  const m = /^([a-z][a-z0-9_-]{1,40}):([0-9a-f-]{36})$/i.exec(id)
  if (!m) throw new EngineError('not_found', 'this item is not waiting for a decision')
  const [, source, itemId] = m
  const { items } = await listPendingApprovals(actor, { source, now: opts.now })
  const item = items.find(i => i.id === itemId)
  if (!item) throw new EngineError('not_found', 'this item is not waiting for a decision')
  if (opts.amount !== undefined && opts.amount !== null) {
    const shown = amountOf(item.content)
    if (shown === null) throw new EngineError('invalid_input', 'this item has no amount to confirm')
    if (Number(opts.amount) !== shown) throw new EngineError('hash_mismatch', `the amount you confirmed (${String(opts.amount)}) is not the amount waiting for approval (${shown}); review it again`)
  }
  const r = await decideApproval(actor, source, itemId, decision === 'approve' ? 'approve' : 'reject', { version: item.version, ip: opts.ip ?? null }, { now: opts.now })
  return { id, decision, status: r.status, source, itemId }
}

// ---------------------------------------------------------------- done, with proof

type ResolvedCase = CaseLite & { id: string; kind: string; title: string; source_app: string; outcome: { summary?: string; evidence?: { label: string; detail?: { url?: string } }[] } | null; closed_at: string; asked: boolean; actions: number }

function proofFor(c: ResolvedCase): Proof {
  const at = (c.records ?? []).find(r => r.type === 'action_type')?.id ?? ''
  const href = `/store/work/${encodeURIComponent(c.ref)}`
  const ev = JSON.stringify(c.outcome?.evidence ?? [])
  if (c.source_app === 'quickbooks' || /quickbooks|intuit/i.test(ev)) return { label: 'QB link', href }
  if (at === 'payout_dispute' || /payout/.test(c.kind)) return { label: `Claim #${c.ref}`, href }
  if (at === 'owner_report' || /report/.test(c.kind)) return { label: 'Report', href }
  if (at === 'update_listing' || /description|listing/.test(c.kind)) return { label: 'Diff', href }
  if (/^(send_|reply|invoice_send)|email|lead|reminder|reply/.test(at || c.kind)) { const n = Math.max(1, c.actions); return { label: `${n} ${n === 1 ? 'reply' : 'replies'}`, href } }
  return { label: 'Before / after', href }
}

async function doneIn(db: Db, orgId: string, st: TeamState, workspace: Workspace, limit: number, now: Date, since?: Date): Promise<DoneItem[]> {
  const cases = await db.query<ResolvedCase>(
    `select c.id, c.ref, c.kind, c.suite, c.title, c.source_app, c.agent_kind, c.agent_ref, c.dedupe_key, c.records, c.outcome, c.closed_at,
       exists (select 1 from case_events e where e.case_id = c.id and e.to_status = 'awaiting_approval') as asked,
       (select count(*)::int from case_events e where e.case_id = c.id and e.type = 'action') as actions
     from cases c where c.org_id = $1 and c.status = 'resolved' and c.suite = $2 and ($4::timestamptz is null or c.closed_at >= $4) order by c.closed_at desc limit $3`,
    [orgId, workspace === 'store' ? 'commerce' : 'office', limit, since?.toISOString() ?? null])
  const out: DoneItem[] = cases.map(c => {
    const ref = refOfCase(st.idx, c)
    const src = ref ? st.sources.find(s => s.id === ref) : undefined
    const agentRec = (c.records ?? []).find(r => r.type === 'agent') as { label?: string } | undefined
    return {
      id: `case:${c.ref}`, agent: { id: ref, name: src?.name ?? agentRec?.label ?? 'Your agent', color: ref ? st.profiles.get(ref)?.color ?? null : null },
      what: c.outcome?.summary || c.title, at: iso(c.closed_at), ago: ago(c.closed_at, now), proof: proofFor(c), onItsOwn: !c.asked, workspace,
    }
  })
  if (workspace === 'store') {
    // reports a library agent ran on its own schedule (no case: there was nothing to fix)
    const reports = await db.query<{ id: string; agent_key: string; title: string; created_at: string }>(
      `select id, agent_key, title, created_at from library_actions where org_id = $1 and status = 'noted' and run_id is not null and ($3::timestamptz is null or created_at >= $3) order by created_at desc limit $2`, [orgId, limit, since?.toISOString() ?? null])
    for (const r of reports) {
      const ref = st.idx.byLibraryKey.get(r.agent_key) ?? (agentByKey(r.agent_key) ? `store:${r.agent_key}` : null)
      out.push({ id: `library:${r.id}`, agent: { id: ref, name: agentByKey(r.agent_key)?.name ?? r.agent_key, color: ref ? st.profiles.get(ref)?.color ?? null : null },
        what: r.title, at: iso(r.created_at), ago: ago(r.created_at, now), proof: { label: 'Report', href: `/store/team/${encodeURIComponent(r.agent_key)}` }, onItsOwn: true, workspace })
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}

/** Completed agent actions on one side of the app, newest first, each with a link to its stored proof. */
export async function doneWithProof(actor: Actor, workspace: Workspace, limit = 20, opts: { now?: Date } = {}): Promise<DoneItem[]> {
  const orgId = merchantOrg(actor)
  const n = Math.min(100, Math.max(1, Math.floor(limit) || 20))
  return admin(async db => doneIn(db, orgId, await teamState(db, orgId), workspace, n, opts.now ?? new Date()))
}

// ---------------------------------------------------------------- team, hero, allowance

function waitingMap(items: NeedsYouItem[]) {
  const m = new Map<string, { count: number; title: string }>()
  for (const i of items) if (i.agent.id) { const w = m.get(i.agent.id) ?? { count: 0, title: i.title }; w.count++; m.set(i.agent.id, w) }
  return m
}

async function teamIn(db: Db, orgId: string, st: TeamState, workspace: Workspace, needs: NeedsYouItem[], now: Date): Promise<TeamAgent[]> {
  const ws = { ...st, sources: st.sources.filter(s => s.workspace === workspace) }
  return liveTeam(db, orgId, ws, waitingMap(needs), now)
}

/** The agents of one side of the app (TeamAgent[]); empty when there are none. */
export async function team(actor: Actor, workspace: Workspace, opts: { now?: Date } = {}): Promise<TeamAgent[]> {
  const orgId = merchantOrg(actor)
  const now = opts.now ?? new Date()
  const { items } = await listPendingApprovals(actor, { now })
  return admin(async db => {
    const st = await teamState(db, orgId)
    return teamIn(db, orgId, st, workspace, await needsYouIn(db, orgId, st, items, now), now)
  })
}

const STORE_EVENT_SOURCES = ['shopify', 'sweep', 'manual']
const OFFICE_EVENT_SOURCES = ['outlook', 'calendar', 'crm', 'quickbooks', 'buildium', 'mailbox', 'sweep', 'crew', 'manual']

async function heroIn(db: Db, orgId: string, st: TeamState, workspace: Workspace, members: TeamAgent[], needs: NeedsYouItem[], now: Date): Promise<Hero> {
  const day = new Date(now.getTime() - 24 * 3600e3), week = new Date(now.getTime() - 7 * 864e5)
  const recent = await doneIn(db, orgId, st, workspace, 1000, now, day)
  let lastCheckAt: string | null = null
  if (members.length) {
    const r = workspace === 'store'
      ? await db.one<{ at: string | null }>(`select greatest(
          (select max(last_run_at) from library_switches where org_id = $1),
          (select max(received_at) from agent_events where org_id = $1 and source = any($2::text[])),
          (select max(started_at) from scans where org_id = $1)) as at`, [orgId, STORE_EVENT_SOURCES])
      : await db.one<{ at: string | null }>(`select greatest(
          (select max(started_at) from office_runs where org_id = $1),
          (select max(received_at) from agent_events where org_id = $1 and source = any($2::text[]))) as at`, [orgId, OFFICE_EVENT_SOURCES])
    lastCheckAt = r?.at ? iso(r.at) : null
  }
  // time saved: the morning report's estimate over the last 7 days, for this side's agents only
  const storeKeys = PACK_AGENTS.filter(a => a.pack === 'commerce').map(a => a.key)
  const updates = await db.one<{ n: number }>(`select count(distinct dedupe_key)::int as n from owner_updates where org_id = $1 and severity = 'info' and status <> 'skipped' and created_at >= $2
      and (agent_key = any($3::text[])) = $4`, [orgId, week.toISOString(), storeKeys, workspace === 'store'])
  const resolved = await db.one<{ n: number }>(`select count(*)::int as n from cases where org_id = $1 and status = 'resolved' and closed_at >= $2 and suite = $3`, [orgId, week.toISOString(), workspace === 'store' ? 'commerce' : 'office'])
  const crew = workspace === 'office' ? await db.one<{ n: number }>(`select count(*)::int as n from crew_jobs where org_id = $1 and status = 'done' and done_at >= $2`, [orgId, week.toISOString()]) : { n: 0 }
  const est = members.length ? estimate({ updates: updates?.n ?? 0, resolved: resolved?.n ?? 0, crewDone: crew?.n ?? 0 }) : { minutes: 0, minutesFormula: 'no agents yet' }
  return {
    agentsRunning: members.filter(m => m.status !== 'off').length, lastCheckAt, handledSinceYesterday: recent.length, needYouCount: needs.length,
    timeSavedWeekMinutes: est.minutes, timeSavedFormula: est.minutesFormula, fixedOnTheirOwn: recent.filter(d => d.onItsOwn).length,
  }
}

/** The headline numbers of one side of the app. */
export async function hero(actor: Actor, workspace: Workspace, opts: { now?: Date } = {}): Promise<Hero> {
  return (await commandCenter(actor, workspace, opts)).hero
}

async function allowanceIn(db: Db, orgId: string, now: Date): Promise<Allowance> {
  const u = await planUsage(db, orgId, now)
  const planName = billingMode() === 'off' ? entitlements().label : (await orgEntitlements(db, orgId, now)).label
  return { used: u.actions, limit: u.actionsLimit, planName, resetsAt: u.resetsAt, enforced: u.enforced }
}

/** This month's agent actions against the plan (lib/plans/allowance). */
export async function allowance(actor: Actor, opts: { now?: Date } = {}): Promise<Allowance> {
  const orgId = merchantOrg(actor)
  return admin(db => allowanceIn(db, orgId, opts.now ?? new Date()))
}

/** Everything the Command center shows for one side, in one read. */
export async function commandCenter(actor: Actor, workspace: Workspace, opts: { now?: Date; doneLimit?: number } = {}): Promise<CommandCenter> {
  const orgId = merchantOrg(actor)
  const now = opts.now ?? new Date()
  const { items } = await listPendingApprovals(actor, { now })
  return admin(async db => {
    const st = await teamState(db, orgId)
    const all = await needsYouIn(db, orgId, st, items, now)
    const needs = all.filter(i => i.workspace === workspace)
    const members = await teamIn(db, orgId, st, workspace, needs, now)
    return {
      workspace, hero: await heroIn(db, orgId, st, workspace, members, needs, now), needsYou: needs,
      doneWithProof: await doneIn(db, orgId, st, workspace, Math.min(100, opts.doneLimit ?? 20), now), team: members, allowance: await allowanceIn(db, orgId, now),
    }
  })
}

// ---------------------------------------------------------------- one agent

/** Find an agent of the actor's organization by its TeamAgent id (either workspace), or throw not_found. */
export async function findAgent(db: Db, orgId: string, id: string): Promise<{ st: TeamState; src: AgentSource }> {
  const st = await teamState(db, orgId)
  const src = st.sources.find(s => s.id === id)
  if (!src) throw new EngineError('not_found', 'agent not found')
  return { st, src }
}

const TIER_LEVEL: Record<string, AgentScope['level']> = { draft: 'draft', send_approved: 'ask', send_autonomous: 'act' }

async function scopesFor(db: Db, orgId: string, src: AgentSource, autonomy: TeamAgent['autonomy'], chosen: boolean): Promise<AgentScope[]> {
  const out: AgentScope[] = []
  const types = await knownActionTypes()
  const label = (k: string) => types.find(t => t.key === k)?.label ?? k.replace(/[_.]/g, ' ')
  const loopLevel = async (t: string): Promise<AgentScope['level']> => (isMoneyAction(t) ? 'ask' : chosen ? (autonomy === 'ask_first' ? 'ask' : 'act') : (await modeFor(db, orgId, t)) === 'ask_first' ? 'ask' : 'act')
  if (src.kind === 'store' && src.loopKey) {
    const cfg = agentByKey(src.key)
    const grants = await db.query<{ action_type: string }>('select action_type from library_auto_run_grants where org_id = $1 and agent_key = $2 and revoked_at is null', [orgId, src.key])
    out.push({ label: 'Read your store', level: 'read' })
    for (const t of src.actions) out.push({ label: label(t), level: await loopLevel(t) })
    for (const a of cfg?.actionTypes ?? []) {
      const perm = src.libraryPermission ?? 'draft'
      const level: AgentScope['level'] = !a.writes || perm === 'read' ? 'read' : APPROVAL_ONLY.has(a.key) ? 'ask' : perm === 'draft' ? 'draft' : grants.some(g => g.action_type === a.key) ? 'act' : 'ask'
      if (!out.some(o => o.label === a.label)) out.push({ label: a.label, level })
    }
  } else if (src.kind === 'store') {
    out.push({ label: 'Read your store', level: 'read' })
    const m = src.engineApprovalMode ?? 'draft'
    for (const t of src.actions) out.push({ label: `Correct ${t.replace(/^store_/, '').replace(/_/g, ' ')}`, level: m === 'autonomous' ? 'act' : m === 'review' ? 'ask' : 'draft' })
  } else if (src.kind === 'office') {
    const p = await db.one<{ policy: Record<string, unknown> }>(`select p.policy from office_agents a join office_agent_policies p on p.id = a.active_policy_id where a.id = $1 and a.org_id = $2`, [src.officeAgentId, orgId])
    const pol = p?.policy ?? {}
    if (pol.hubspotConnectionId) out.push({ label: 'Read your CRM', level: 'read' })
    if (pol.calendarConnectionId) out.push({ label: 'Read your calendar', level: 'read' })
    if (pol.quickbooksConnectionId) out.push({ label: 'Read QuickBooks', level: 'read' })
    if (pol.mailboxAccountId) out.push({ label: 'Read the mailbox', level: 'read' })
    const t = src.officeTiers
    if (t?.email) out.push({ label: 'Send email', level: TIER_LEVEL[t.email] ?? 'draft' })
    if (t?.calendar) out.push({ label: 'Book and move meetings', level: TIER_LEVEL[t.calendar] ?? 'draft' })
    if (t?.crm) out.push({ label: 'Update the CRM', level: TIER_LEVEL[t.crm] ?? 'draft' })
  } else {
    for (const t of src.actions) out.push({ label: label(t), level: await loopLevel(t) })
  }
  return out
}

const RESULT: Record<string, string> = {
  resolved: 'Done, verified', awaiting_approval: 'Waiting for you', executing: 'Doing it now', verifying: 'Checking it worked', blocked: 'Stuck, retrying', failed: 'Could not finish',
  cancelled: 'Cancelled', escalated: 'Needs you', detected: 'Spotted', investigating: 'Looking into it', proposed: 'Proposed', waiting_external: 'Waiting on someone else',
}

async function statsFor(db: Db, orgId: string, src: AgentSource, waiting: number, now: Date): Promise<AgentStat[]> {
  const d30 = new Date(now.getTime() - 30 * 864e5).toISOString(), d7 = new Date(now.getTime() - 7 * 864e5).toISOString()
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const n = async (sql: string, params: unknown[]) => (await db.one<{ n: number }>(sql, params))?.n ?? 0
  if (src.kind === 'store' && src.loopKey) {
    const week = await libraryWeek(db, orgId, new Date(d7))
    const minutes = week.agents.find(a => a.agentKey === src.key)?.minutes ?? 0
    const used = await n(`select count(*)::int as n from library_actions where org_id = $1 and agent_key = $2 and status = 'done' and coalesce(executed_at, created_at) >= $3`, [orgId, src.key, month])
    if (src.key === 'inventory_watcher') {
      const watched = await n(`select coalesce((select s.resources_scanned from scans s join store_connections c on c.id = s.connection_id where s.org_id = $1 and c.status = 'active' and s.status = 'completed' order by s.started_at desc limit 1), 0)::int as n`, [orgId])
      const prevented = await n(`select count(*)::int as n from library_actions where org_id = $1 and agent_key = 'inventory_watcher' and status = 'done' and action_type in ('selling_past_zero','best_seller_low_stock','flag_oversold','draft_inventory_policy_fix','draft_restock_request') and created_at >= $2`, [orgId, d30])
      return [{ key: 'products_watched', label: 'Products watched', value: watched, unit: 'count' }, { key: 'sellouts_prevented_30d', label: 'Sell-outs prevented (30 days)', value: prevented, unit: 'count' },
        { key: 'time_saved_week', label: 'Time saved this week', value: minutes, unit: 'minutes' }, { key: 'actions_month', label: 'Actions used this month', value: used, unit: 'count' }]
    }
    const handled = await n(`select count(*)::int as n from library_actions where org_id = $1 and agent_key = $2 and status in ('done','noted') and created_at >= $3`, [orgId, src.key, d30])
    return [{ key: 'handled_30d', label: 'Handled (30 days)', value: handled, unit: 'count' }, { key: 'waiting', label: 'Waiting for you', value: waiting, unit: 'count' },
      { key: 'time_saved_week', label: 'Time saved this week', value: minutes, unit: 'minutes' }, { key: 'actions_month', label: 'Actions used this month', value: used, unit: 'count' }]
  }
  if (src.kind === 'store') {
    const q = (since: string) => n(`select count(*)::int as n from executions e join proposals p on p.id = e.proposal_id where e.org_id = $1 and p.agent_id = $2 and e.status = 'verified' and e.started_at >= $3`, [orgId, src.engineAgentId, since])
    const week = await q(d7)
    return [{ key: 'verified_30d', label: 'Changes verified (30 days)', value: await q(d30), unit: 'count' }, { key: 'waiting', label: 'Waiting for you', value: waiting, unit: 'count' },
      { key: 'time_saved_week', label: 'Time saved this week', value: week * ESTIMATE_MINUTES.verifiedChange, unit: 'minutes' },
      { key: 'actions_month', label: 'Actions used this month', value: await n(`select count(*)::int as n from executions e join proposals p on p.id = e.proposal_id where e.org_id = $1 and p.agent_id = $2 and e.status in ('executing','applied','verified','unknown') and e.started_at >= $3`, [orgId, src.engineAgentId, month]), unit: 'count' }]
  }
  if (src.kind === 'office') {
    const id = src.officeAgentId
    const kind = (await db.one<{ kind: string }>('select kind from office_agents where id = $1', [id]))?.kind
    const first: AgentStat = kind === 'lead_followup' ? { key: 'leads_active', label: 'Leads in follow-up', value: await n(`select count(*)::int as n from office_leads where org_id = $1 and agent_id = $2 and status = 'active'`, [orgId, id]), unit: 'count' }
      : kind === 'meeting_scheduler' ? { key: 'meetings_booked_30d', label: 'Meetings booked (30 days)', value: await n(`select count(*)::int as n from office_meetings where org_id = $1 and agent_id = $2 and status = 'booked' and updated_at >= $3`, [orgId, id, d30]), unit: 'count' }
      : kind === 'accounts_receivable' ? { key: 'invoices_tracked', label: 'Overdue invoices tracked', value: await n(`select count(*)::int as n from office_invoices where org_id = $1 and agent_id = $2 and status in ('open','held','disputed')`, [orgId, id]), unit: 'count' }
      : { key: 'replies_30d', label: 'Messages answered (30 days)', value: await n(`select count(*)::int as n from office_actions where org_id = $1 and agent_id = $2 and kind = 'send_email' and status = 'succeeded' and created_at >= $3`, [orgId, id, d30]), unit: 'count' }
    const week = await n(`select count(*)::int as n from office_actions where org_id = $1 and agent_id = $2 and status = 'succeeded' and coalesce(executed_at, updated_at) >= $3`, [orgId, id, d7])
    return [first, { key: 'waiting', label: 'Waiting for you', value: waiting, unit: 'count' }, { key: 'time_saved_week', label: 'Time saved this week', value: week * MORNING_MINUTES.update, unit: 'minutes' },
      { key: 'actions_month', label: 'Actions used this month', value: await n(`select count(*)::int as n from office_actions where org_id = $1 and agent_id = $2 and status in ('executing','succeeded','unknown') and executing_started_at >= $3`, [orgId, id, month]), unit: 'count' }]
  }
  const loops = (since: string) => n(`select count(*)::int as n from agent_loops where org_id = $1 and agent_key = $2 and state = 'done' and updated_at >= $3`, [orgId, src.loopKey, since])
  return [{ key: 'handled_30d', label: 'Handled (30 days)', value: await loops(d30), unit: 'count' }, { key: 'waiting', label: 'Waiting for you', value: waiting, unit: 'count' },
    { key: 'time_saved_week', label: 'Time saved this week', value: (await loops(d7)) * MORNING_MINUTES.update, unit: 'minutes' }, { key: 'actions_month', label: 'Actions used this month', value: await loops(month), unit: 'count' }]
}

async function workFor(db: Db, orgId: string, st: TeamState, src: AgentSource): Promise<WorkRow[]> {
  const cases = await db.query<ResolvedCase & { status: string; updated_at: string }>(
    `select c.id, c.ref, c.kind, c.suite, c.title, c.source_app, c.agent_kind, c.agent_ref, c.dedupe_key, c.records, c.outcome, c.closed_at, c.status, c.updated_at, false as asked,
       (select count(*)::int from case_events e where e.case_id = c.id and e.type = 'action') as actions
     from cases c where c.org_id = $1 and c.suite = $2 order by c.updated_at desc limit 400`, [orgId, src.workspace === 'store' ? 'commerce' : 'office'])
  const rows: WorkRow[] = cases.filter(c => refOfCase(st.idx, c) === src.id).slice(0, 30).map(c => ({
    when: iso(c.closed_at ?? c.updated_at), what: c.outcome?.summary || c.title, result: RESULT[c.status] ?? c.status,
    proof: c.status === 'resolved' ? proofFor(c) : { label: `Case ${c.ref}`, href: `/store/work/${encodeURIComponent(c.ref)}` },
  }))
  if (src.kind === 'store' && src.loopKey) {
    const lib = await db.query<{ id: string; title: string; status: string; created_at: string }>(`select id, title, status, created_at from library_actions where org_id = $1 and agent_key = $2 and run_id is not null order by created_at desc limit 20`, [orgId, src.key])
    for (const a of lib) rows.push({ when: iso(a.created_at), what: a.title, result: a.status === 'noted' ? 'Reported' : a.status === 'draft' ? 'Waiting for you' : a.status === 'done' ? 'Done' : a.status, proof: { label: a.status === 'noted' ? 'Report' : 'Log', href: `/store/team/${encodeURIComponent(src.key)}` } })
  }
  return rows.sort((a, b) => b.when.localeCompare(a.when)).slice(0, 30)
}

async function tasksFor(db: Db, orgId: string, st: TeamState, src: AgentSource): Promise<AgentTask[]> {
  const rows = await db.query<{ ref: string; problem: string; status: string; agent_kind: string | null; agent_ref: string | null; dedupe_key: string; records: { type: string; id: string }[]; updated_at: string }>(
    `select ref, problem, status, agent_kind, agent_ref, dedupe_key, records, updated_at from cases where org_id = $1 and kind = 'owner_task' order by (status in ('resolved','cancelled')), updated_at desc limit 200`, [orgId])
  return rows.filter(r => refOfCase(st.idx, r) === src.id).slice(0, 10).map(r => ({
    ref: r.ref, text: r.problem, status: r.status, result: r.status === 'resolved' ? 'Done' : RESULT[r.status] ?? r.status, open: !['resolved', 'cancelled'].includes(r.status), at: iso(r.updated_at),
  }))
}

/** One agent's page: the agent, four stats for its kind, what it may do (from its real grants), its work and instructions. */
export async function agentDashboard(actor: Actor, id: string, opts: { now?: Date } = {}): Promise<AgentDashboard> {
  const orgId = merchantOrg(actor)
  const now = opts.now ?? new Date()
  const { items } = await listPendingApprovals(actor, { now })
  return admin(async db => {
    const { st, src } = await findAgent(db, orgId, id)
    const needs = (await needsYouIn(db, orgId, st, items, now)).filter(i => i.agent.id === id)
    const [agent] = await liveTeam(db, orgId, { ...st, sources: [src] }, waitingMap(needs), now)
    return {
      agent, stats: await statsFor(db, orgId, src, needs.length, now), scopes: await scopesFor(db, orgId, src, agent.autonomy, agent.autonomyChosen),
      work: await workFor(db, orgId, st, src), instructions: await listInstructionsIn(db, orgId, id), tasks: await tasksFor(db, orgId, st, src),
    }
  })
}
