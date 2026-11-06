/**
 * Running a commerce agent for one event. Every problem goes through the shared agent loop (lib/events/loop.ts):
 * detect (a fresh re-check) -> the owner's mode for the action -> act -> verify with a fresh read -> proof -> owner update.
 * The work log is library_actions (one row per problem handled, with evidence, proof and undo), which the privacy
 * export/erase already covers. Idempotency: a problem key is handled once per organization, across agents, under an
 * advisory lock, so a duplicate webhook or two agents seeing the same product never act twice.
 */
import { admin, type Db } from '../../db'
import type { AgentEvent } from '../../events'
import { runAgentLoop, type LoopOutcome } from '../../events/loop'
import { notifyOwner, type ProofItem } from '../../notify'
import { undoKind } from '../../undo'
import { orgStopReason } from '../../engine/kill-switch'
import type { ConnectionRow } from '../../engine/types'
import { commerceAgent, DEFAULT_SETTINGS, type ActResult, type Ctx, type PackSettings, type Problem } from './agents'
import { CommerceError, syntheticCommerceStore, type CMail, type CommerceStore } from './store'
import { liveCommerceStoreFor } from './live-store'

export type ProblemOutcome = { key: string; kind: string; status: LoopOutcome['status'] | 'already_handled' | 'skipped_uninstalled'; actionId: string | null; latencyMs: number | null; error?: string }
export type CommerceRunResult = { agentKey: string; status: 'ran' | 'skipped' | 'failed'; reason?: string; outcomes: ProblemOutcome[] }

/** Tests and the seeding script can supply the store; normally it comes from the organization's active connection. */
let storeOverride: ((orgId: string) => Promise<CommerceStore | null>) | null = null
export function setCommerceStoreOverride(fn: typeof storeOverride) { storeOverride = fn }

export async function commerceStoreFor(orgId: string, settings: Record<string, unknown> = {}): Promise<{ store: CommerceStore; connectionId: string | null } | null> {
  if (storeOverride) { const s = await storeOverride(orgId); return s ? { store: s, connectionId: null } : null }
  const conn = await admin(db => db.one<ConnectionRow & { is_synthetic: boolean }>(`select * from store_connections where org_id = $1 and platform = 'shopify' and status = 'active' order by created_at limit 1`, [orgId]))
  if (!conn) return null
  const promoted = Array.isArray(settings.promotedCollections) ? settings.promotedCollections.map(String) : []
  return { store: conn.is_synthetic ? syntheticCommerceStore(conn.id) : liveCommerceStoreFor(conn, { promotedHandles: promoted }), connectionId: conn.id }
}

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof PackSettings)[]
function settingsFrom(storePolicy: Record<string, unknown>, sw: Record<string, unknown>): PackSettings {
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>
  for (const src of [storePolicy, sw]) for (const k of SETTING_KEYS) if (src[k] !== undefined && src[k] !== null && typeof src[k] === typeof DEFAULT_SETTINGS[k]) out[k] = src[k]
  return out as PackSettings
}

/** Record ids an event is about: the Shopify GraphQL id, order/product ids, or the mail message id. */
export function eventRecordIds(e: AgentEvent): string[] {
  const x = e.payload
  const ids: string[] = []
  if (typeof x.admin_graphql_api_id === 'string') ids.push(x.admin_graphql_api_id)
  if (x.order_id !== undefined) ids.push(`gid://shopify/Order/${x.order_id}`)
  if (x.product_id !== undefined) ids.push(`gid://shopify/Product/${x.product_id}`)
  if ((e.type === 'mail.received' || e.source === 'mailbox' || e.source === 'outlook') && typeof x.id === 'string') ids.push(x.id)
  return ids
}

/** A mail event on a store whose mailbox is not readable through the store (live): the message joins the inbox. */
function withEventMail(store: CommerceStore, e: AgentEvent): CommerceStore {
  const x = e.payload
  if (e.type !== 'mail.received' || typeof x.id !== 'string' || typeof x.from !== 'string') return store
  const m: CMail = { id: x.id, from: x.from, subject: String(x.subject ?? ''), text: String(x.text ?? ''), receivedAt: String(x.receivedAt ?? e.occurredAt), inReplyTo: typeof x.inReplyTo === 'string' ? x.inReplyTo : null }
  return { ...store, inbox: async () => { const list = await store.inbox(); return list.some(y => y.id === m.id) ? list : [...list, m] } }
}

type SwitchRow = { enabled: boolean; settings: Record<string, unknown> }
type WorkRow = { id: string; status: string; mode: string; agent_key: string; payload: Record<string, unknown> }

async function alreadyHandled(db: Db, orgId: string, key: string): Promise<boolean> {
  const rows = await db.query<{ status: string; n: string }>(`select status, count(*)::text as n from library_actions where org_id = $1 and payload->>'dedupeKey' = $2 and status <> 'expired' group by status`, [orgId, key])
  const by = Object.fromEntries(rows.map(r => [r.status, Number(r.n)]))
  // a problem is handled once; a failure is tried again on the next event, at most twice in all
  return Boolean(by.done || by.draft || by.approved || by.declined || by.noted || (by.failed ?? 0) >= 2)
}

async function connectionActive(orgId: string, connectionId: string | null) {
  if (!connectionId) return true
  const r = await admin(db => db.one<{ status: string }>('select status from store_connections where id = $1 and org_id = $2', [connectionId, orgId]))
  return r?.status === 'active'
}

/** Build the context for an agent of an organization, or say why it cannot run. */
export async function commerceContext(orgId: string, agentKey: string, e?: AgentEvent, now = new Date()): Promise<{ ctx: Ctx; connectionId: string | null } | { skip: string }> {
  const sw = await admin(db => db.one<SwitchRow>('select enabled, settings from library_switches where org_id = $1 and agent_key = $2', [orgId, agentKey]))
  // the launch pack is on by default: an agent the owner switched off does not run
  if (sw && !sw.enabled) return { skip: 'switched off' }
  const stopped = await admin(db => orgStopReason(db, orgId))
  if (stopped) return { skip: stopped }
  const src = await commerceStoreFor(orgId, sw?.settings ?? {})
  if (!src) return { skip: 'no active Shopify store' }
  const store = e ? withEventMail(src.store, e) : src.store
  const policy = await store.policy()
  const settings = settingsFrom(policy as Record<string, unknown>, sw?.settings ?? {})
  const shop = await store.shop()
  return { ctx: { orgId, agentKey, store, settings, now, shopName: shop.name.replace(/\s*\(synthetic\)$/, '') }, connectionId: src.connectionId }
}

/** Handle one event for one commerce agent. */
export async function runCommerceAgent(agentKey: string, e: AgentEvent, opts: { now?: Date } = {}): Promise<CommerceRunResult> {
  const agent = commerceAgent(agentKey)
  if (!agent) return { agentKey, status: 'failed', reason: 'unknown agent', outcomes: [] }
  let c: Awaited<ReturnType<typeof commerceContext>>
  try { c = await commerceContext(e.orgId, agentKey, e, opts.now ?? new Date()) } catch (err) { return { agentKey, status: 'failed', reason: (err as Error).message, outcomes: [] } }
  if ('skip' in c) return { agentKey, status: 'skipped', reason: c.skip, outcomes: [] }
  const { ctx, connectionId } = c
  let problems: Problem[]
  try { problems = await agent.find(ctx) } catch (err) {
    return { agentKey, status: 'failed', reason: err instanceof CommerceError ? `${err.code}: ${err.message}` : (err as Error).message, outcomes: [] }
  }
  const scope = eventRecordIds(e)
  if (agent.scoped && scope.length && e.type !== 'sweep') problems = problems.filter(p => p.recordIds.some(id => scope.includes(id)))
  const outcomes: ProblemOutcome[] = []
  let stopped = false
  for (const p of problems) {
    if (stopped || !(await connectionActive(e.orgId, connectionId))) { stopped = true; outcomes.push({ key: p.key, kind: p.kind, status: 'skipped_uninstalled', actionId: null, latencyMs: null }); continue }
    outcomes.push(await handleProblem(ctx, agent.name, p, e))
    if (outcomes[outcomes.length - 1].error?.startsWith('uninstalled')) stopped = true
  }
  return { agentKey, status: 'ran', outcomes }
}

async function handleProblem(ctx: Ctx, agentName: string, p: Problem, e: AgentEvent): Promise<ProblemOutcome> {
  return admin(async db => {
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [`commerce:${ctx.orgId}:${p.key}`])
    if (await alreadyHandled(db, ctx.orgId, p.key)) return { key: p.key, kind: p.kind, status: 'already_handled' as const, actionId: null, latencyMs: null }
    let detectedAt: number | null = null
    let done: ActResult | null = null
    let error: string | undefined
    const outcome = await runAgentLoop<Problem>(db, {
      orgId: ctx.orgId, agentKey: ctx.agentKey, agentName, actionType: p.actionType, problemKey: p.key,
      detect: async () => { const there = await p.stillThere(ctx); detectedAt = Date.now(); return there ? p : null },
      describe: x => ({ title: x.title, whatHappened: x.whatHappened, whatIDid: x.ownerDecision ? [...x.whatIDid, `Your decision: ${x.ownerDecision.question}`] : x.whatIDid }),
      act: async () => {
        try { done = await p.act(ctx) } catch (err) { error = err instanceof CommerceError ? `${err.code}: ${err.message}` : (err as Error).message; throw new Error(error) }
        return { undo: done.undo ?? null, proof: done.proof }
      },
      verify: async () => p.verify(ctx, done!),
      detailsPath: '/store/work',
    })
    if (outcome.status === 'nothing_to_do') return { key: p.key, kind: p.kind, status: outcome.status, actionId: null, latencyMs: null }
    const latencyMs = detectedAt === null ? null : Math.max(0, detectedAt - new Date(e.occurredAt).getTime())
    const proof: ProofItem[] = outcome.status === 'done' || outcome.status === 'not_verified' ? outcome.proof : []
    const decisionOpen = outcome.status === 'done' && p.ownerDecision
    const status = outcome.status === 'done' ? (decisionOpen ? 'draft' : 'done') : outcome.status === 'waiting_for_owner' ? 'draft' : 'failed'
    const mode = outcome.status === 'waiting_for_owner' ? 'draft' : 'auto'
    const reason = outcome.status === 'failed' ? outcome.error.slice(0, 300) : outcome.status === 'not_verified' ? 'the fresh read did not confirm the change' : outcome.status === 'waiting_for_owner' ? 'ask first: waiting for the owner' : decisionOpen ? 'waiting for the owner to decide' : null
    const actDone = done as ActResult | null
    const row = await db.one<{ id: string }>(
      `insert into library_actions (org_id, agent_key, action_type, title, summary, evidence, payload, mode, status, status_reason, proof, permission_basis, executed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [ctx.orgId, ctx.agentKey, p.kind, p.title.slice(0, 300), p.whatHappened.slice(0, 2000),
        JSON.stringify({ ...p.evidence, eventType: e.type, eventSource: e.source, eventId: e.externalId, eventAt: e.occurredAt, detectedAt: detectedAt ? new Date(detectedAt).toISOString() : null, latencyMs }),
        JSON.stringify({ dedupeKey: p.key, actionType: p.actionType, whatIDid: p.whatIDid, undo: actDone?.undo ?? null, options: p.ownerDecision ? Object.keys(p.ownerDecision.options) : outcome.status === 'waiting_for_owner' ? ['approve', 'decline'] : [], question: p.ownerDecision?.question ?? null, facts: actDone?.facts ?? null }),
        mode, status, reason, JSON.stringify({ items: proof, verified: outcome.status === 'done' }), `commerce_pack:${outcome.status === 'waiting_for_owner' ? 'ask_first' : 'act_and_tell'}`,
        outcome.status === 'done' || outcome.status === 'not_verified' ? new Date().toISOString() : null])
    return { key: p.key, kind: p.kind, status: outcome.status, actionId: row?.id ?? null, latencyMs, ...(outcome.status === 'failed' ? { error: error ?? outcome.error } : {}) }
  })
}

/**
 * The owner's answer to a prepared action: 'approve' runs what ask-first held back (act + fresh-read verify);
 * an ownerDecision option (e.g. a return outside policy: 'approve' or 'decline') runs that option. The problem is
 * re-detected first, so nothing happens if it went away meanwhile.
 */
export async function decideCommerceWork(orgId: string, actionId: string, option: string, actor: string): Promise<{ ok: boolean; status: string; proof: ProofItem[] }> {
  const row = await admin(db => db.one<WorkRow>(`select id, status, mode, agent_key, payload from library_actions where id = $1 and org_id = $2`, [actionId, orgId]))
  if (!row || row.status !== 'draft') return { ok: false, status: 'not_waiting', proof: [] }
  const agent = commerceAgent(row.agent_key)
  const c = agent ? await commerceContext(orgId, row.agent_key) : { skip: 'unknown agent' }
  if ('skip' in c) return { ok: false, status: c.skip, proof: [] }
  const key = String(row.payload.dedupeKey)
  const p = (await agent!.find(c.ctx)).find(x => x.key === key) ?? null
  const finish = async (status: string, reason: string, proof: ProofItem[], ok: boolean) => {
    await admin(db => db.query(`update library_actions set status = $3, status_reason = $4, proof = $5, decided_by = $6, decided_at = now(), executed_at = case when $3 = 'done' then now() else executed_at end, updated_at = now() where id = $1 and org_id = $2`,
      [actionId, orgId, status, reason, JSON.stringify({ items: proof, verified: ok }), actor]))
    return { ok, status, proof }
  }
  if (option === 'decline' && row.mode === 'draft') return finish('declined', `declined by ${actor}`, [], true)
  if (!p || !(await p.stillThere(c.ctx))) return finish('expired', 'the problem is no longer there', [], false)
  let result: { ok: boolean; proof: ProofItem[] }
  try {
    if (row.mode === 'draft' && option === 'approve') {
      const done = await p.act(c.ctx)
      const v = await p.verify(c.ctx, done)
      result = { ok: v.ok, proof: [...done.proof, ...v.proof] }
      if (done.undo) await admin(db => db.query(`update library_actions set payload = payload || jsonb_build_object('undo', $2::jsonb) where id = $1`, [actionId, JSON.stringify(done.undo)]))
    } else {
      const o = p.ownerDecision?.options[option]
      if (!o) return { ok: false, status: 'unknown_option', proof: [] }
      result = await o.run(c.ctx)
    }
  } catch (err) {
    return finish('failed', (err as Error).message.slice(0, 300), [], false)
  }
  await notifyOwner({ orgId, agentKey: row.agent_key, agentName: agent!.name, headline: `${p.title}: ${option === 'approve' ? 'done' : option} as you asked`, whatHappened: p.whatHappened, whatIDid: [`You chose: ${option}.`], proof: result.proof, detailsPath: '/store/work', severity: result.ok ? 'info' : 'warning', dedupeKey: `${row.agent_key}:${key}:decided:${option}` })
  return finish(result.ok ? 'done' : 'failed', result.ok ? `${option} by ${actor}` : 'the fresh read did not confirm the change', result.proof, result.ok)
}

/** Reverse a done action through its registered undo (lib/undo). */
export async function undoCommerceWork(orgId: string, actionId: string, actor: string): Promise<{ ok: boolean; detail: string }> {
  const row = await admin(db => db.one<WorkRow & { status_reason: string | null }>(`select id, status, mode, agent_key, payload, status_reason from library_actions where id = $1 and org_id = $2`, [actionId, orgId]))
  const undo = row?.payload.undo as { kind: string; payload: Record<string, unknown> } | null | undefined
  if (!row || row.status !== 'done' || !undo) return { ok: false, detail: 'nothing to undo' }
  if (row.status_reason?.startsWith('undone')) return { ok: false, detail: 'already undone' }
  const fn = undoKind(undo.kind)
  if (!fn) return { ok: false, detail: `no undo registered for ${undo.kind}` }
  const r = await admin(db => fn(db, { ...undo.payload, orgId }))
  if (r.ok) await admin(db => db.query(`update library_actions set status_reason = $3, updated_at = now() where id = $1 and org_id = $2`, [actionId, orgId, `undone by ${actor}: ${r.detail}`.slice(0, 300)]))
  return r
}
