/**
 * Running a library agent and deciding what happens to each action it wants to take:
 *  read   -> only reports are kept ("noted"); nothing that writes or sends is even drafted
 *  draft  -> anything that writes or sends waits in the approval queue; reports are noted
 *  act    -> an action type with a live auto-run grant (and under its daily cap) runs now and is logged
 *            with proof; everything else waits for approval exactly as at draft
 * Money actions and live sends are approval-only at every level: no grant can cover them.
 * Every action is written to library_actions with its evidence, the permission that allowed it, and
 * the proof of what happened; usage is recorded per action for billing.
 */
import { randomUUID } from 'node:crypto'
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { agentByKey, actionTypeOf, type PermissionLevel } from './config'
import { LibraryError, isLibraryError } from './errors'
import { runnerFor, type ActionDraft, type RunnerContext } from './runners'
import { storeDataFor, type StoreData } from './store-data'
import { recordUsage } from './usage'
import { runAgent } from '../agents/run'

/** Action types that move money or publish to the outside world: approval-only at every permission level. */
export const APPROVAL_ONLY = new Set(['approve_return', 'create_discount', 'end_discount', 'send_customer_reply'])
/** Action types whose "execution" would be an email or a message leaving the store: never sent by this build. */
const SENDS = new Set(['draft_customer_update', 'draft_return_reply', 'draft_restock_request', 'draft_supplier_followup', 'draft_customer_reply', 'send_customer_reply', 'draft_campaign_email'])

export type RunCounts = { noted: number; drafted: number; done: number; failed: number; skipped: number; approvedUnsent: number }
export type LibraryRunResult = { runId: string; status: 'completed' | 'blocked' | 'failed'; reason?: string; counts: RunCounts; engine?: Record<string, unknown> }

export type SwitchRow = { id: string; org_id: string; agent_key: string; enabled: boolean; permission: PermissionLevel; standing_instructions: string; settings: Record<string, unknown>; engine_agent_id: string | null; last_run_at: string | null; last_run_status: string | null }

const empty = (): RunCounts => ({ noted: 0, drafted: 0, done: 0, failed: 0, skipped: 0, approvedUnsent: 0 })

/** Performs a write from its stored payload and returns the proof (a fresh read). One mapping for approval and for auto-run. */
export async function executePayload(data: StoreData, actionType: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const s = (k: string) => String(payload[k] ?? '')
  switch (actionType) {
    case 'draft_title': return data.setProductText(s('productId') || String((payload.evidenceProductId ?? '')), 'title', s('to'))
    case 'draft_description': return data.setProductText(s('productId'), 'description', s('to'))
    case 'draft_inventory_policy_fix': return data.setInventoryPolicy(s('variantId'), s('to') === 'DENY' ? 'DENY' : 'CONTINUE')
    case 'approve_return': return data.approveReturn(s('returnId'))
    case 'create_discount': return data.createDiscount({ code: s('code'), percent: Number(payload.percent ?? 0), endsAt: payload.endsAt ? s('endsAt') : null })
    case 'end_discount': return data.endDiscount(s('discountId'))
    default: return null
  }
}

/** The ids a write needs are copied from the evidence so the payload is self-contained. */
function executable(d: ActionDraft): Record<string, unknown> {
  const e = d.evidence
  return { ...d.payload, ...(e.productId && !d.payload.productId ? { productId: e.productId } : {}), ...(e.variantId && !d.payload.variantId ? { variantId: e.variantId } : {}) }
}

export async function runLibraryAgent(opts: { orgId: string; agentKey: string; trigger: 'manual' | 'schedule' | 'chat' | 'test'; actor: string; now?: Date; permission?: PermissionLevel; instructions?: string; settings?: Record<string, unknown>; customAgentId?: string | null }): Promise<LibraryRunResult> {
  const now = opts.now ?? new Date()
  const runId = randomUUID()
  const cfg = agentByKey(opts.agentKey)
  if (!cfg) throw new LibraryError('not_found', 'unknown agent')
  const runner = runnerFor(opts.agentKey)
  if (!runner) throw new LibraryError('not_found', 'this agent has no runner')
  const logKey = opts.customAgentId ? `custom:${opts.customAgentId}` : opts.agentKey
  const sw = opts.customAgentId ? null : await admin(db => db.one<SwitchRow>('select * from library_switches where org_id = $1 and agent_key = $2', [opts.orgId, opts.agentKey]))
  if (!opts.customAgentId && (!sw || !sw.enabled)) throw new LibraryError('conflict', 'this agent is switched off')
  const permission: PermissionLevel = opts.permission ?? sw?.permission ?? 'draft'
  const instructions = opts.instructions ?? sw?.standing_instructions ?? ''
  const settings = opts.settings ?? sw?.settings ?? {}
  const counts = empty()
  const finish = async (status: LibraryRunResult['status'], reason?: string, engine?: Record<string, unknown>) => {
    if (!opts.customAgentId) await admin(db => db.query('update library_switches set last_run_at = $3, last_run_status = $4 where org_id = $1 and agent_key = $2', [opts.orgId, opts.agentKey, now.toISOString(), status]))
    await admin(db => audit(db, { orgId: opts.orgId, entityType: 'library', entityId: logKey, event: `library.run.${status}`, actor: opts.actor, detail: { run_id: runId, agent_key: logKey, trigger: opts.trigger, permission, reason: reason ?? null, counts, engine: engine ?? null } }))
    return { runId, status, reason, counts, engine }
  }
  await admin(db => audit(db, { orgId: opts.orgId, entityType: 'library', entityId: logKey, event: 'library.run.started', actor: opts.actor, detail: { run_id: runId, agent_key: logKey, trigger: opts.trigger, permission } }))

  // the three engine-backed agents also run their correction-engine agent, whose own work log is the proof
  let engine: Record<string, unknown> | undefined
  if (sw?.engine_agent_id) {
    try {
      const r = await runAgent(sw.engine_agent_id, { trigger: opts.trigger === 'chat' ? 'manual' : opts.trigger === 'test' ? 'test' : opts.trigger, actor: opts.actor, now })
      engine = { runId: r.runId, status: r.status, reason: r.reason ?? null, counts: r.counts }
    } catch (e) { engine = { status: 'skipped', reason: (e as Error).message } }
  }

  let drafts: ActionDraft[]
  let data: StoreData
  try {
    const src = await storeDataFor(opts.orgId, now)
    data = src.data
    const ctx: RunnerContext = { data, instructions, settings, now }
    drafts = await runner(ctx)
  } catch (e) {
    if (isLibraryError(e)) return finish(e.code === 'not_wired' || e.code === 'needs_setup' ? 'blocked' : 'failed', e.message, engine)
    return finish('failed', `could not read the store: ${(e as Error).message.slice(0, 160)}`, engine)
  }

  const grants = await admin(db => db.query<{ action_type: string; max_per_day: number }>('select action_type, max_per_day from library_auto_run_grants where org_id = $1 and agent_key = $2 and revoked_at is null', [opts.orgId, logKey]))
  const grantFor = (t: string) => grants.find(g => g.action_type === t) ?? null
  const dayStart = new Date(now.getTime() - 864e5).toISOString()

  for (const d of drafts) {
    const at = actionTypeOf(opts.agentKey, d.actionType)
    if (!at) { counts.skipped++; continue }
    const writes = at.writes
    if (permission === 'read' && writes) { counts.skipped++; continue }
    const dedupe = d.payload.dedupeKey ?? null
    await admin(async db => {
      // one open draft per record; a report is noted once a day
      if (dedupe) {
        const dup = await db.one<{ id: string }>(`select id from library_actions where org_id = $1 and agent_key = $2 and action_type = $3 and payload->>'dedupeKey' = $4 and (status = 'draft' or created_at > $5) limit 1`, [opts.orgId, logKey, d.actionType, dedupe, dayStart])
        if (dup) { counts.skipped++; return }
      }
      const payload = executable(d)
      if (!writes) {
        const id = await insert(db, { orgId: opts.orgId, agentKey: logKey, runId, d, payload, mode: 'read', status: 'noted', basis: `${permission}: reports need no approval`, proof: { facts: d.evidence, reportedAt: now.toISOString() } })
        await recordUsage(db, { orgId: opts.orgId, agentKey: logKey, actionType: d.actionType, actionId: id })
        counts.noted++
        return
      }
      const grant = permission === 'act' && !APPROVAL_ONLY.has(d.actionType) ? grantFor(d.actionType) : null
      if (grant) {
        const today = await db.one<{ n: string }>(`select count(*)::text as n from library_actions where org_id = $1 and agent_key = $2 and action_type = $3 and mode = 'auto' and created_at > $4`, [opts.orgId, logKey, d.actionType, dayStart])
        if (Number(today?.n ?? 0) >= grant.max_per_day) {
          const id = await insert(db, { orgId: opts.orgId, agentKey: logKey, runId, d, payload, mode: 'draft', status: 'draft', basis: `act: auto-run cap of ${grant.max_per_day} a day reached, so this one waits for you`, proof: null })
          await recordUsage(db, { orgId: opts.orgId, agentKey: logKey, actionType: d.actionType, actionId: id })
          counts.drafted++
          return
        }
        if (SENDS.has(d.actionType)) {
          const id = await insert(db, { orgId: opts.orgId, agentKey: logKey, runId, d, payload, mode: 'auto', status: 'approved', basis: `act: auto-run granted for "${at.label}"`, proof: { sent: false, reason: 'email sending is off in this environment; the message is ready to copy' }, reason: 'auto-run granted, but email sending is off in this environment: nothing was sent' })
          await recordUsage(db, { orgId: opts.orgId, agentKey: logKey, actionType: d.actionType, actionId: id })
          counts.approvedUnsent++
          return
        }
        const r = await performWrite(data, d.actionType, payload, now)
        const id = await insert(db, { orgId: opts.orgId, agentKey: logKey, runId, d, payload, mode: 'auto', status: r.ok ? 'done' : 'failed', basis: `act: auto-run granted for "${at.label}" (max ${grant.max_per_day} a day)`, proof: r.proof, reason: r.ok ? null : r.reason, executedAt: now })
        await recordUsage(db, { orgId: opts.orgId, agentKey: logKey, actionType: d.actionType, actionId: id })
        if (r.ok) counts.done++; else counts.failed++
        return
      }
      const basis = APPROVAL_ONLY.has(d.actionType) ? `${permission}: "${at.label}" moves money or publishes, so it always waits for your approval` : permission === 'act' ? `act: no auto-run grant for "${at.label}", so it waits for you` : 'draft: every change waits for your approval'
      const id = await insert(db, { orgId: opts.orgId, agentKey: logKey, runId, d, payload, mode: 'draft', status: 'draft', basis, proof: null })
      await recordUsage(db, { orgId: opts.orgId, agentKey: logKey, actionType: d.actionType, actionId: id })
      counts.drafted++
    })
  }
  return finish('completed', undefined, engine)
}

async function insert(db: Db, a: { orgId: string; agentKey: string; runId: string; d: ActionDraft; payload: Record<string, unknown>; mode: 'read' | 'draft' | 'auto'; status: string; basis: string; proof: Record<string, unknown> | null; reason?: string | null; executedAt?: Date }) {
  const row = await db.one<{ id: string }>(
    `insert into library_actions (org_id, agent_key, action_type, run_id, title, summary, evidence, payload, mode, status, status_reason, proof, permission_basis, executed_at, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, case when $10 = 'draft' then now() + interval '14 days' else null end) returning id`,
    [a.orgId, a.agentKey, a.d.actionType, a.runId, a.d.title.slice(0, 200), a.d.summary.slice(0, 2000), JSON.stringify(a.d.evidence), JSON.stringify(a.payload), a.mode, a.status, a.reason ?? null, a.proof ? JSON.stringify(a.proof) : null, a.basis, a.executedAt?.toISOString() ?? null])
  return row!.id
}

async function performWrite(data: StoreData, actionType: string, payload: Record<string, unknown>, now: Date): Promise<{ ok: boolean; proof: Record<string, unknown>; reason?: string }> {
  try {
    const r = await executePayload(data, actionType, payload)
    if (!r) return { ok: false, proof: { attempted: false }, reason: 'this action type has no store write' }
    return { ok: true, proof: { ...r, verifiedBy: 'fresh read after the write', at: now.toISOString(), synthetic: data.synthetic } }
  } catch (e) {
    return { ok: false, proof: { attempted: true, error: (e as Error).message.slice(0, 300) }, reason: isLibraryError(e) ? e.message : `the store refused: ${(e as Error).message.slice(0, 160)}` }
  }
}

export type ActionRow = {
  id: string; org_id: string; agent_key: string; action_type: string; run_id: string | null; title: string; summary: string; evidence: Record<string, unknown>; payload: Record<string, unknown>
  mode: 'read' | 'draft' | 'auto'; status: 'draft' | 'approved' | 'declined' | 'done' | 'failed' | 'noted' | 'expired'; status_reason: string | null; proof: Record<string, unknown> | null
  permission_basis: string | null; decided_by: string | null; decided_at: string | null; executed_at: string | null; created_at: string; updated_at: string; expires_at: string | null
}

async function visibleAction(actor: Actor, id: string): Promise<ActionRow> {
  const a = await withActor(actor, db => db.one<ActionRow>('select * from library_actions where id = $1', [id]))
  if (!a) throw new LibraryError('not_found', 'action not found')
  return a
}

/** The merchant approves one draft. A store write runs now and the fresh read is the proof; a message is marked approved (nothing is sent in this build). */
export async function approveAction(actor: Actor, id: string, now = new Date()) {
  const a = await visibleAction(actor, id)
  assertMerchant(actor, a.org_id)
  if (a.status !== 'draft') throw new LibraryError('conflict', `this action is ${a.status}, not waiting for approval`)
  if (a.expires_at && new Date(a.expires_at).getTime() < now.getTime()) {
    await admin(db => db.query(`update library_actions set status = 'expired', status_reason = 'expired before it was approved' where id = $1`, [id]))
    throw new LibraryError('conflict', 'this draft expired; run the agent again for a fresh one')
  }
  if (SENDS.has(a.action_type) || !['draft_title', 'draft_description', 'draft_inventory_policy_fix', 'approve_return', 'create_discount', 'end_discount'].includes(a.action_type)) {
    await admin(async db => {
      await db.query(`update library_actions set status = 'approved', status_reason = $2, decided_by = $3, decided_at = $4, proof = $5 where id = $1`,
        [id, SENDS.has(a.action_type) ? 'approved; email sending is off in this environment, so nothing was sent. Copy the text to send it yourself.' : 'approved', actor.label, now.toISOString(), JSON.stringify({ approvedBy: actor.label, sent: false })])
      await audit(db, { orgId: a.org_id, entityType: 'library', entityId: a.agent_key, event: 'library.action.approved', actor: actor.label, detail: { action_id: id, action_type: a.action_type, executed: false } })
    })
    return { status: 'approved' as const, executed: false }
  }
  const src = await storeDataFor(a.org_id, now)
  const r = await performWrite(src.data, a.action_type, a.payload, now)
  await admin(async db => {
    await db.query(`update library_actions set status = $2, status_reason = $3, decided_by = $4, decided_at = $5, executed_at = $5, proof = $6 where id = $1`,
      [id, r.ok ? 'done' : 'failed', r.ok ? null : r.reason ?? null, actor.label, now.toISOString(), JSON.stringify({ ...r.proof, approvedBy: actor.label })])
    await audit(db, { orgId: a.org_id, entityType: 'library', entityId: a.agent_key, event: r.ok ? 'library.action.done' : 'library.action.failed', actor: actor.label, detail: { action_id: id, action_type: a.action_type, reason: r.reason ?? null } })
  })
  return { status: r.ok ? ('done' as const) : ('failed' as const), executed: r.ok, reason: r.reason, proof: { ...r.proof, approvedBy: actor.label } }
}

export async function declineAction(actor: Actor, id: string, reason?: string, now = new Date()) {
  const a = await visibleAction(actor, id)
  assertMerchant(actor, a.org_id)
  if (a.status !== 'draft') throw new LibraryError('conflict', `this action is ${a.status}, not waiting for approval`)
  await admin(async db => {
    await db.query(`update library_actions set status = 'declined', status_reason = $2, decided_by = $3, decided_at = $4 where id = $1`, [id, reason?.slice(0, 300) || 'declined by you', actor.label, now.toISOString()])
    await audit(db, { orgId: a.org_id, entityType: 'library', entityId: a.agent_key, event: 'library.action.declined', actor: actor.label, detail: { action_id: id, action_type: a.action_type, reason: reason ?? null } })
  })
}

export type LogEntry = { at: string; kind: 'action' | 'run' | 'switch' | 'engine'; what: string; status: string; permission: string; ref: { type: string; id: string | null }; detail?: Record<string, unknown> }

/** Everything an agent did, in order: its actions with proof, its runs, switch and grant changes, and (for engine-backed agents) the engine's runs. */
export async function activityLog(actor: Actor, orgId: string, agentKey: string, opts: { limit?: number } = {}): Promise<LogEntry[]> {
  const limit = Math.min(opts.limit ?? 100, 300)
  return withActor(actor, async db => {
    const actions = await db.query<ActionRow>('select * from library_actions where org_id = $1 and agent_key = $2 order by created_at desc limit $3', [orgId, agentKey, limit])
    const events = await db.query<{ event: string; actor: string; detail: Record<string, unknown>; at: string }>(
      `select event, actor, detail, at from engine_audit where org_id = $1 and entity_type = 'library' and entity_id = $2 and event not like 'library.action.%' order by at desc limit $3`, [orgId, agentKey, limit])
    const sw = await db.one<{ engine_agent_id: string | null }>('select engine_agent_id from library_switches where org_id = $1 and agent_key = $2', [orgId, agentKey])
    const engineRuns = sw?.engine_agent_id ? await db.query<{ id: string; status: string; status_reason: string | null; counts: Record<string, unknown>; started_at: string; policy_version: number | null }>('select id, status, status_reason, counts, started_at, policy_version from agent_runs where agent_id = $1 order by started_at desc limit 20', [sw.engine_agent_id]) : []
    const STATUS: Record<string, string> = { draft: 'Waiting for your approval', approved: 'Approved', declined: 'Declined', done: 'Done, verified by a fresh read', failed: 'Failed', noted: 'Reported', expired: 'Expired' }
    const out: LogEntry[] = [
      ...actions.map(a => ({ at: a.created_at, kind: 'action' as const, what: a.title, status: STATUS[a.status] ?? a.status, permission: a.permission_basis ?? '', ref: { type: 'action', id: a.id }, detail: { action_type: a.action_type, mode: a.mode, status: a.status, status_reason: a.status_reason, proof: a.proof, decided_by: a.decided_by, executed_at: a.executed_at } })),
      ...events.map(e => ({ at: e.at, kind: (e.event.startsWith('library.run') ? 'run' : 'switch') as 'run' | 'switch', what: EVENT_WORDS[e.event] ?? e.event, status: e.event.split('.').pop() ?? '', permission: `you (${e.actor})`.replace('you (system', '(system').replace(/^you \((agent|system)[^)]*\)$/, 'Deploi (automatic)'), ref: { type: 'event', id: null }, detail: e.detail })),
      ...engineRuns.map(r => ({ at: r.started_at, kind: 'engine' as const, what: `Correction engine run ${r.status}${r.status_reason ? `: ${r.status_reason}` : ''}`, status: r.status, permission: `engine authorization v${r.policy_version ?? '?'}`, ref: { type: 'engine_run', id: r.id }, detail: r.counts })),
    ]
    const ms = (v: string) => new Date(v).getTime()
    return out.map(e => ({ ...e, at: new Date(e.at).toISOString() })).sort((a, b) => ms(b.at) - ms(a.at)).slice(0, limit)
  })
}

const EVENT_WORDS: Record<string, string> = {
  'library.run.started': 'Run started', 'library.run.completed': 'Run finished', 'library.run.blocked': 'Run blocked', 'library.run.failed': 'Run failed',
  'library.switch.on': 'Switched on', 'library.switch.off': 'Switched off', 'library.permission': 'Permission level changed', 'library.instructions': 'Standing instructions updated',
  'library.autorun.granted': 'Auto-run granted', 'library.autorun.revoked': 'Auto-run revoked', 'library.settings': 'Settings changed',
}

export async function listActions(actor: Actor, orgId: string, opts: { agentKey?: string | null; status?: string | null; limit?: number } = {}): Promise<ActionRow[]> {
  return withActor(actor, db => db.query<ActionRow>(
    `select * from library_actions where org_id = $1 and ($2::text is null or agent_key = $2) and ($3::text is null or status = $3) order by created_at desc limit $4`,
    [orgId, opts.agentKey ?? null, opts.status ?? null, Math.min(opts.limit ?? 100, 300)]))
}

/** Scheduler: run every switched-on library agent whose last run is older than its interval (daily). Each agent runs at most once per call. */
export async function runDueLibraryAgents(opts: { now?: Date; limit?: number; intervalHours?: number } = {}) {
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - (opts.intervalHours ?? 24) * 3600e3).toISOString()
  const due = await admin(db => db.query<{ org_id: string; agent_key: string }>(
    `select s.org_id, s.agent_key from library_switches s join store_connections c on c.org_id = s.org_id and c.status = 'active'
     where s.enabled and (s.last_run_at is null or s.last_run_at <= $1)
     order by s.switched_at limit $2`, [since, opts.limit ?? 50]))
  const results: { orgId: string; agentKey: string; status: string; reason?: string }[] = []
  for (const d of due) {
    try { const r = await runLibraryAgent({ orgId: d.org_id, agentKey: d.agent_key, trigger: 'schedule', actor: 'system:scheduler', now }); results.push({ orgId: d.org_id, agentKey: d.agent_key, status: r.status, reason: r.reason }) }
    catch (e) { results.push({ orgId: d.org_id, agentKey: d.agent_key, status: 'skipped', reason: (e as Error).message }) }
  }
  return results
}
