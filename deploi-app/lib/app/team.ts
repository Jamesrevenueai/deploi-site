/**
 * The unified team (lib/app/contract.ts TeamAgent): every agent of an organization across kinds, read from the
 * real records only, with its colour (agent_profiles), status, what it is doing now and its actions today.
 *
 *   store workspace   the commerce pack / agent library agents (store:<key>: all twelve while a Shopify store is
 *                     connected, otherwise the library agents with a switch) and store agents built on the
 *                     correction engine (store:<uuid>, not the ones a library switch created)
 *   office workspace  Office agents (office:<uuid>, not deleted or revoked) and the agents of the organization's
 *                     non-commerce packs (pack:<key>), except the Office pack's wrappers around Office agents (their
 *                     work is the Office agents' own work and is shown on them)
 */
import type { Db } from '../db'
import '../events/agents'
import { LIBRARY, agentByKey } from '../library/config'
import { PACK_AGENTS, PACKS } from '../packs/registry'
import { OFFICE_KINDS } from '../packs/office'
import { orgPacks } from '../packs/settings'
import { OFFICE_KIND_LABEL, type OfficeKind } from '../office/policy'
import { orgStopReason } from '../engine/kill-switch'
import { modeFor, isMoneyAction } from '../autonomy'
import { ensureProfiles, DEFAULT_AUTONOMY, type AgentAutonomy, type AgentProfileRow } from './profiles'
import type { AgentKind, TeamAgent, Workspace } from './contract'

/** One area word per store agent (what it looks after). */
const STORE_AREA: Record<string, string> = {
  order_tracker: 'Orders', returns: 'Returns', listing_writer: 'Listings', inventory_watcher: 'Inventory', supplier_chaser: 'Suppliers', customer_care: 'Customers',
  campaign: 'Marketing', promo_manager: 'Discounts', weekly_insights: 'Reports', payout_fees_checker: 'Payouts', store_health_checker: 'Store health', ai_visibility: 'Search',
}
const OFFICE_AREA: Record<string, string> = {
  lead_followup: 'Leads', meeting_scheduler: 'Calendar', crm_updater: 'CRM', customer_reply: 'Inbox', accounts_receivable: 'Invoices', email_operations: 'Inbox',
}
const OFFICE_WRAPPERS = new Set(Object.keys(OFFICE_KINDS))
const isoOf = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString() : new Date(0).toISOString())

/** A team member before its live state is added (internal). */
export type AgentSource = {
  id: string; kind: AgentKind; workspace: Workspace; name: string; area: string; job: string; createdAt: string
  /** store: library key; store engine: engine agent id; office: office agent id; pack: pack agent key */
  key: string
  /** the loop agent key whose loops and cases are this agent's (store library / pack agents) */
  loopKey: string | null
  officeAgentId: string | null
  engineAgentId: string | null
  /** what the records say: active (true) or switched off / paused / not granted (false) */
  on: boolean
  offReason: string | null
  /** derived autonomy when the owner never chose one */
  derivedAutonomy: AgentAutonomy
  libraryPermission: string | null
  officeTiers: { email: string | null; calendar: string | null; crm: string | null } | null
  engineApprovalMode: string | null
  actions: string[]
}

export const workspaceOfRef = (ref: string): Workspace => (ref.startsWith('store:') ? 'store' : 'office')

async function loopAutonomy(db: Db, orgId: string, actions: string[]): Promise<AgentAutonomy> {
  // with no level chosen, the agent asks first when the owner set ask_first for any non-money action it takes
  for (const t of actions) if (!isMoneyAction(t) && (await modeFor(db, orgId, t)) === 'ask_first') return 'ask_first'
  return DEFAULT_AUTONOMY
}

/** Every agent of the organization (both workspaces), in creation order. */
export async function agentSources(db: Db, orgId: string): Promise<AgentSource[]> {
  const out: AgentSource[] = []
  const stopped = await orgStopReason(db, orgId)
  // ---- store: the agent library / commerce pack
  const shopify = await db.one<{ created_at: string }>(`select created_at from store_connections where org_id = $1 and platform = 'shopify' and status = 'active' order by created_at limit 1`, [orgId])
  const switches = await db.query<{ agent_key: string; enabled: boolean; permission: string; engine_agent_id: string | null; created_at: string }>(
    'select agent_key, enabled, permission, engine_agent_id, created_at from library_switches where org_id = $1', [orgId])
  const commerceKeys = new Set(PACK_AGENTS.filter(a => a.pack === 'commerce').map(a => a.key))
  for (const a of LIBRARY.agents) {
    const sw = switches.find(s => s.agent_key === a.key)
    // the commerce pack runs every agent on a connected Shopify store unless the owner switched it off
    const listed = (shopify && commerceKeys.has(a.key)) || Boolean(sw?.enabled)
    if (!listed) continue
    const on = sw ? sw.enabled : true
    const pack = PACK_AGENTS.find(p => p.key === a.key)
    const actions = pack?.actions ?? []
    out.push({
      id: `store:${a.key}`, kind: 'store', workspace: 'store', name: a.name, area: STORE_AREA[a.key] ?? 'Store', job: pack?.job ?? a.tagline, createdAt: isoOf(sw?.created_at ?? shopify?.created_at),
      key: a.key, loopKey: a.key, officeAgentId: null, engineAgentId: sw?.engine_agent_id ?? null,
      on: on && !stopped, offReason: stopped ?? (on ? null : 'switched off'),
      derivedAutonomy: shopify && commerceKeys.has(a.key) ? await loopAutonomy(db, orgId, actions) : (sw?.permission === 'act' ? 'act_then_tell' : 'ask_first'),
      libraryPermission: sw?.permission ?? null, officeTiers: null, engineApprovalMode: null, actions,
    })
  }
  // ---- store: agents built on the correction engine (not the ones a library switch created)
  const linked = new Set(switches.map(s => s.engine_agent_id).filter(Boolean) as string[])
  const engine = await db.query<{ id: string; name: string; status: string; created_at: string; mode: string | null; correction_types: string[] | null }>(
    `select a.id, a.name, a.status, a.created_at, p.policy->>'approvalMode' as mode, array(select jsonb_array_elements_text(coalesce(p.policy->'correctionTypes', '[]'::jsonb))) as correction_types
     from agents a left join agent_policies p on p.id = a.active_policy_id where a.org_id = $1 and a.status in ('draft','active','paused') order by a.created_at`, [orgId])
  for (const e of engine) {
    if (linked.has(e.id)) continue
    out.push({
      id: `store:${e.id}`, kind: 'store', workspace: 'store', name: e.name, area: 'Custom agent', job: 'Checks your store and corrects what its authorization covers.', createdAt: isoOf(e.created_at),
      key: e.id, loopKey: null, officeAgentId: null, engineAgentId: e.id, on: e.status === 'active' && !stopped, offReason: stopped ?? (e.status === 'active' ? null : e.status === 'paused' ? 'paused' : 'waiting for your grant'),
      derivedAutonomy: e.mode === 'autonomous' ? 'act_then_tell' : 'ask_first', libraryPermission: null, officeTiers: null, engineApprovalMode: e.mode ?? 'draft', actions: (e.correction_types ?? []).map(t => `store_${t}`),
    })
  }
  // ---- office: Office agents
  const office = await db.query<{ id: string; kind: OfficeKind; name: string; status: string; created_at: string; email: string | null; calendar: string | null; crm: string | null }>(
    `select a.id, a.kind, a.name, a.status, a.created_at, p.policy->'email'->>'tier' as email, p.policy->'calendar'->>'tier' as calendar, p.policy->'crm'->>'tier' as crm
     from office_agents a left join office_agent_policies p on p.id = a.active_policy_id where a.org_id = $1 and a.status in ('draft','active','paused') order by a.created_at`, [orgId])
  for (const o of office) {
    const tiers = [o.email, o.calendar, o.crm].filter(Boolean) as string[]
    out.push({
      id: `office:${o.id}`, kind: 'office', workspace: 'office', name: o.name, area: OFFICE_AREA[o.kind] ?? 'Office', job: `${OFFICE_KIND_LABEL[o.kind] ?? o.kind}: works under the authorization you granted it.`, createdAt: isoOf(o.created_at),
      key: o.id, loopKey: null, officeAgentId: o.id, engineAgentId: null, on: o.status === 'active' && !stopped, offReason: stopped ?? (o.status === 'active' ? null : o.status === 'paused' ? 'paused' : 'waiting for your grant'),
      derivedAutonomy: tiers.length && tiers.every(t => t === 'send_autonomous') ? 'act_then_tell' : 'ask_first', libraryPermission: null, officeTiers: { email: o.email, calendar: o.calendar, crm: o.crm }, engineApprovalMode: null, actions: [],
    })
  }
  // ---- office: the organization's non-commerce packs
  const packs = await orgPacks(db, orgId).catch(() => null)
  const packSince = isoOf((await db.one<{ created_at: string }>('select created_at from pack_settings where org_id = $1', [orgId]))?.created_at)
  for (const a of PACK_AGENTS) {
    if (a.pack === 'commerce' || a.status === 'planned' || OFFICE_WRAPPERS.has(a.key) || !packs?.packs.includes(a.pack)) continue
    out.push({
      id: `pack:${a.key}`, kind: 'pack', workspace: 'office', name: a.name, area: PACKS[a.pack].name, job: a.job, createdAt: packSince,
      key: a.key, loopKey: a.key, officeAgentId: null, engineAgentId: null, on: !stopped, offReason: stopped, derivedAutonomy: await loopAutonomy(db, orgId, a.actions),
      libraryPermission: null, officeTiers: null, engineApprovalMode: null, actions: a.actions,
    })
  }
  // two different agents can carry the same name (a library agent and a custom agent built from the template of the
  // same name): both are real and both stay; the custom one is told apart in its name
  const used = new Set(out.filter(a => !(a.engineAgentId && !a.loopKey)).map(a => `${a.workspace}:${a.name.toLowerCase()}`))
  for (const a of out) {
    if (!(a.engineAgentId && !a.loopKey)) continue
    let name = a.name
    for (let n = 1; used.has(`${a.workspace}:${name.toLowerCase()}`); n++) name = `${a.name} (custom${n > 1 ? ` ${n}` : ''})`
    used.add(`${a.workspace}:${name.toLowerCase()}`); a.name = name
  }
  // creation order (stable): the colours are assigned in this order on first sight
  return out.map((a, i) => ({ a, i })).sort((x, y) => x.a.createdAt.localeCompare(y.a.createdAt) || x.i - y.i).map(x => x.a)
}

/** Agent ref of a stored record: a case's owner, a loop's agent key, an approval item's agent. */
export type RefIndex = { byLibraryKey: Map<string, string>; byEngineId: Map<string, string>; byOfficeId: Map<string, string>; byLoopKey: Map<string, string> }
export function refIndex(sources: AgentSource[]): RefIndex {
  const idx: RefIndex = { byLibraryKey: new Map(), byEngineId: new Map(), byOfficeId: new Map(), byLoopKey: new Map() }
  for (const s of sources) {
    if (s.kind === 'store' && s.loopKey) { idx.byLibraryKey.set(s.key, s.id); idx.byLoopKey.set(s.loopKey, s.id) }
    if (s.engineAgentId) idx.byEngineId.set(s.engineAgentId, s.id)
    if (s.officeAgentId) idx.byOfficeId.set(s.officeAgentId, s.id)
    if (s.kind === 'pack' && s.loopKey) idx.byLoopKey.set(s.loopKey, s.id)
  }
  return idx
}

/** The agent ref for a loop's agent key and problem key (an Office pack wrapper's loop belongs to the Office agent it ran). */
export function refOfLoop(idx: RefIndex, agentKey: string, problemKey: string | null): string | null {
  if (OFFICE_WRAPPERS.has(agentKey) && problemKey) {
    const m = /^office:([0-9a-f-]{36}):/.exec(problemKey)
    if (m) return idx.byOfficeId.get(m[1]) ?? `office:${m[1]}`
  }
  const known = idx.byLoopKey.get(agentKey)
  if (known) return known
  const a = PACK_AGENTS.find(x => x.key === agentKey)
  return a ? (a.pack === 'commerce' ? `store:${a.key}` : `pack:${a.key}`) : null
}

export function refOfCase(idx: RefIndex, c: { agent_kind: string | null; agent_ref: string | null; dedupe_key: string; records: { type: string; id: string }[] }): string | null {
  if (c.agent_kind === 'library' && c.agent_ref) return idx.byLibraryKey.get(c.agent_ref) ?? (agentByKey(c.agent_ref) ? `store:${c.agent_ref}` : null)
  if (c.agent_kind === 'office' && c.agent_ref) return idx.byOfficeId.get(c.agent_ref) ?? `office:${c.agent_ref}`
  if (c.agent_kind === 'engine' && c.agent_ref) return idx.byEngineId.get(c.agent_ref) ?? `store:${c.agent_ref}`
  const agent = (c.records ?? []).find(r => r.type === 'agent')
  if (agent) return refOfLoop(idx, agent.id, c.dedupe_key.startsWith('loop:') ? c.dedupe_key.slice(5) : null)
  return null
}

export type TeamState = { sources: AgentSource[]; profiles: Map<string, AgentProfileRow>; idx: RefIndex }

/** Sources plus their profiles (created on first sight, in creation order). */
export async function teamState(db: Db, orgId: string): Promise<TeamState> {
  const sources = await agentSources(db, orgId)
  const profiles = await ensureProfiles(db, orgId, sources.map(s => s.id))
  return { sources, profiles, idx: refIndex(sources) }
}

/** The live part of each agent: open work, actions today. */
export async function liveTeam(db: Db, orgId: string, st: TeamState, waiting: Map<string, { count: number; title: string }>, now = new Date()): Promise<TeamAgent[]> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
  const loops = await db.query<{ agent_key: string; problem_key: string; state: string; title: string | null; updated_at: string }>(
    `select agent_key, problem_key, state, action->>'title' as title, updated_at from agent_loops where org_id = $1 and (state in ('acting','approved') or (state = 'done' and updated_at >= $2))`, [orgId, dayStart])
  const lib = await db.query<{ agent_key: string; n: number }>(`select agent_key, count(*)::int as n from library_actions where org_id = $1 and run_id is not null and status in ('done','noted') and coalesce(executed_at, created_at) >= $2 group by agent_key`, [orgId, dayStart])
  const off = await db.query<{ agent_id: string; n: number }>(`select agent_id, count(*)::int as n from office_actions where org_id = $1 and status = 'succeeded' and coalesce(executed_at, updated_at) >= $2 group by agent_id`, [orgId, dayStart])
  const runningOffice = await db.query<{ agent_id: string }>(`select distinct agent_id from office_runs where org_id = $1 and status = 'running' and started_at > $2`, [orgId, new Date(now.getTime() - 15 * 60_000).toISOString()])
  const exec = await db.query<{ agent_id: string; n: number }>(`select p.agent_id, count(*)::int as n from executions e join proposals p on p.id = e.proposal_id where e.org_id = $1 and p.agent_id is not null and e.status in ('applied','verified') and e.started_at >= $2 group by p.agent_id`, [orgId, dayStart])
  return st.sources.map(s => {
    const prof = st.profiles.get(s.id)
    const mine = loops.filter(l => refOfLoop(st.idx, l.agent_key, l.problem_key) === s.id)
    const acting = mine.find(l => l.state === 'acting' || l.state === 'approved')
    const today = mine.filter(l => l.state === 'done').length + (s.kind === 'store' && s.loopKey ? (lib.find(x => x.agent_key === s.key)?.n ?? 0) : 0)
      + (s.officeAgentId ? (off.find(x => x.agent_id === s.officeAgentId)?.n ?? 0) : 0) + (s.engineAgentId && !s.loopKey ? (exec.find(x => x.agent_id === s.engineAgentId)?.n ?? 0) : 0)
    const w = waiting.get(s.id)
    const paused = Boolean(prof?.paused_at)
    let status: TeamAgent['status'], doingNow: string
    if (!s.on || paused) { status = 'off'; doingNow = paused ? 'Paused by you' : `Off: ${s.offReason ?? 'not running'}` }
    else if (w?.count) { status = 'waiting'; doingNow = w.count > 1 ? `Waiting for you on ${w.count} things: ${w.title}` : `Waiting for you: ${w.title}` }
    else if (acting || (s.officeAgentId && runningOffice.some(r => r.agent_id === s.officeAgentId))) { status = 'working'; doingNow = acting?.title ? `Working on: ${acting.title}` : 'Running its check now' }
    else { status = 'watching'; doingNow = `Watching ${s.area.toLowerCase()}` }
    return {
      id: s.id, kind: s.kind, name: s.name, area: s.area, color: prof?.color ?? '#4F6BFF', status, doingNow, todayActions: today,
      autonomy: prof?.autonomy_set_at ? prof.autonomy : s.derivedAutonomy, autonomyChosen: Boolean(prof?.autonomy_set_at), workspace: s.workspace, job: s.job,
    }
  })
}
