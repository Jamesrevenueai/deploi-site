/**
 * Event router. SHARED INTERFACE — owned by workstream W1.
 * Every trigger (Shopify webhook, new Outlook mail or calendar event, CRM/QuickBooks/Buildium change, or the
 * 15-minute sweep) becomes one AgentEvent; the router dedupes it by (source, externalId) and hands it to every
 * handler registered for its type. Handlers run the agent loop: detect -> fix -> verify -> log proof -> notify.
 *
 * routeEvent(e):
 *  - records the event in agent_events, unique per (source, organization, external id). A second delivery of the
 *    same event is recorded as a duplicate (counter + time) and dropped: no second job is queued;
 *  - queues ONE durable job (`event.handle`, lib/jobs) per handler registered for the type (and '*'), with an
 *    idempotency key per event and agent, so a retried route never queues twice;
 *  - each job runs its handler once per attempt; a handler that throws is retried with exponential backoff
 *    (lib/jobs backoff) and dead-lettered after its attempts; every attempt's outcome is recorded on the event
 *    (agent_events.outcomes[agentKey]).
 *  - while an organization has stopped all its agents, the event is recorded as `refused` and nothing is queued.
 *
 * Handlers are registered by each pack's module on import (onEvent). The worker must import those modules: add
 * them to lib/events/agents.ts, which the job handler loads before it looks a handler up.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Db } from '../db'

/** The stored event and handler a running `event.handle` job is serving (the first-run pacing re-runs it later). */
export const currentEvent = new AsyncLocalStorage<{ eventId: string; agentKey: string }>()

export type EventSource = 'shopify' | 'outlook' | 'calendar' | 'crm' | 'quickbooks' | 'buildium' | 'mailbox' | 'sweep' | 'crew' | 'manual'
export type AgentEvent = {
  source: EventSource
  /** e.g. 'orders/create', 'refunds/create', 'mail.received', 'lead.email', 'invoice.overdue', 'sweep' */
  type: string
  orgId: string
  /** provider id used for dedupe (webhook id, message id, record id + version) */
  externalId: string
  occurredAt: string
  payload: Record<string, unknown>
}
export type EventHandler = (db: Db, e: AgentEvent) => Promise<void>
const handlers = new Map<string, { agentKey: string; fn: EventHandler }[]>()

/** Register an agent's handler for an event type ('*' receives every event, e.g. the sweep). */
export function onEvent(type: string, agentKey: string, fn: EventHandler) {
  const list = handlers.get(type) ?? []
  if (!list.some(h => h.agentKey === agentKey)) list.push({ agentKey, fn })
  handlers.set(type, list)
}
export function handlersFor(type: string) { return [...(handlers.get(type) ?? []), ...(handlers.get('*') ?? [])] }

/** Remove an agent's handler (tests, and an agent pack switched off at runtime). */
export function offEvent(type: string, agentKey: string) {
  const list = (handlers.get(type) ?? []).filter(h => h.agentKey !== agentKey)
  if (list.length) handlers.set(type, list); else handlers.delete(type)
}

export const EVENT_SOURCES: readonly EventSource[] = ['shopify', 'outlook', 'calendar', 'crm', 'quickbooks', 'buildium', 'mailbox', 'sweep', 'crew', 'manual']
const TYPE = /^[a-z][a-z0-9_./:-]{0,79}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Largest payload kept with an event (bytes of JSON); larger payloads keep their top-level ids only. */
export const MAX_EVENT_PAYLOAD = 512 * 1024
export const EVENT_JOB = 'event.handle'

export type RouteResult = {
  status: 'routed' | 'duplicate' | 'no_handlers' | 'refused'
  eventId: string
  /** job ids queued for this delivery (empty for a duplicate) */
  jobs: string[]
  handlers: string[]
  reason?: string
}

export class EventError extends Error { constructor(message: string) { super(message); this.name = 'EventError' } }

function cleanPayload(p: Record<string, unknown>): Record<string, unknown> {
  const raw = JSON.stringify(p ?? {})
  if (raw.length <= MAX_EVENT_PAYLOAD) return JSON.parse(raw.replace(/\\u0000/g, ''))
  const keep: Record<string, unknown> = { truncated: true }
  for (const [k, v] of Object.entries(p)) if (['id', 'admin_graphql_api_id', 'name', 'order_id', 'updated_at'].includes(k) && (typeof v === 'string' || typeof v === 'number')) keep[k] = v
  return keep
}

export function validateEvent(e: AgentEvent): AgentEvent {
  if (!e || typeof e !== 'object') throw new EventError('an event is required')
  if (!EVENT_SOURCES.includes(e.source)) throw new EventError(`unknown event source: ${String(e.source)}`)
  if (typeof e.type !== 'string' || !TYPE.test(e.type)) throw new EventError(`invalid event type: ${String(e.type).slice(0, 80)}`)
  if (typeof e.orgId !== 'string' || !UUID.test(e.orgId)) throw new EventError('invalid organization id')
  if (typeof e.externalId !== 'string' || !e.externalId.trim()) throw new EventError('an event needs the provider id used for dedupe')
  const at = new Date(e.occurredAt ?? Date.now())
  return {
    source: e.source, type: e.type, orgId: e.orgId, externalId: e.externalId.trim().slice(0, 300),
    occurredAt: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
    payload: cleanPayload(e.payload && typeof e.payload === 'object' ? e.payload : {}),
  }
}

/**
 * Route one event: dedupe, then one durable job per registered handler. Pass `db` to record and queue inside the
 * caller's transaction (service role); otherwise its own.
 */
export async function routeEvent(e: AgentEvent, opts: { db?: Db } = {}): Promise<RouteResult> {
  const ev = validateEvent(e)
  const { admin } = await import('../db')
  const run = async (db: Db): Promise<RouteResult> => {
    const { enqueue } = await import('../jobs/queue')
    const { orgStopReason } = await import('../engine/kill-switch')
    const names = handlersFor(ev.type).map(h => h.agentKey)
    const unique = [...new Set(names)]
    const stopped = await orgStopReason(db, ev.orgId)
    const status = stopped ? 'refused' : unique.length ? 'routed' : 'no_handlers'
    const row = await db.one<{ id: string }>(
      `insert into agent_events (org_id, source, type, external_id, occurred_at, payload, status, handlers) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (source, org_id, external_id) do nothing returning id`,
      [ev.orgId, ev.source, ev.type, ev.externalId, ev.occurredAt, JSON.stringify(ev.payload), status, stopped ? [] : unique])
    if (!row) {
      const dup = await db.one<{ id: string; handlers: string[] }>(
        `update agent_events set duplicates = duplicates + 1, last_duplicate_at = now() where source = $1 and org_id = $2 and external_id = $3 returning id, handlers`, [ev.source, ev.orgId, ev.externalId])
      return { status: 'duplicate', eventId: dup!.id, jobs: [], handlers: dup!.handlers }
    }
    if (stopped) return { status: 'refused', eventId: row.id, jobs: [], handlers: [], reason: stopped }
    const jobs: string[] = []
    for (const agentKey of unique) {
      const q = await enqueue({ kind: EVENT_JOB, orgId: ev.orgId, payload: { eventId: row.id, agentKey }, idempotencyKey: `${row.id}:${agentKey}`.slice(0, 200) }, db)
      if (q.id) jobs.push(q.id)
    }
    return { status, eventId: row.id, jobs, handlers: unique }
  }
  return opts.db ? run(opts.db) : admin(run)
}

type EventRow = { id: string; org_id: string; source: EventSource; type: string; external_id: string; occurred_at: string; payload: Record<string, unknown>; outcomes: Record<string, { attempts?: number }> }

async function recordOutcome(eventId: string, agentKey: string, o: Record<string, unknown>) {
  const { admin } = await import('../db')
  await admin(db => db.query(`update agent_events set outcomes = outcomes || jsonb_build_object($2::text, $3::jsonb) where id = $1`, [eventId, agentKey, JSON.stringify({ ...o, at: new Date().toISOString() })]))
}

/** Run one agent's handler for one stored event (the `event.handle` job). Throws to let the queue retry. */
export async function handleStoredEvent(eventId: string, agentKey: string, jobOrgId: string | null, attempt = 1): Promise<Record<string, unknown>> {
  const { admin } = await import('../db')
  await import('./agents')
  const row = await admin(db => db.one<EventRow>('select id, org_id, source, type, external_id, occurred_at, payload, outcomes from agent_events where id = $1', [eventId]))
  if (!row) return { skipped: true, reason: 'event not found' }
  // a job acts only for its own organization (ids in a payload are data)
  if (jobOrgId && row.org_id !== jobOrgId) return { skipped: true, reason: 'the event belongs to another organization' }
  const h = handlersFor(row.type).find(x => x.agentKey === agentKey)
  if (!h) {
    await recordOutcome(eventId, agentKey, { status: 'failed', attempts: attempt, error: 'no handler is registered for this agent' })
    throw new Error(`no handler registered for ${agentKey} on ${row.type}`)
  }
  const e: AgentEvent = { source: row.source, type: row.type, orgId: row.org_id, externalId: row.external_id, occurredAt: new Date(row.occurred_at).toISOString(), payload: row.payload ?? {} }
  await recordOutcome(eventId, agentKey, { status: 'running', attempts: attempt })
  try {
    await currentEvent.run({ eventId, agentKey }, () => admin(db => h.fn(db, e)))
  } catch (err) {
    await recordOutcome(eventId, agentKey, { status: 'failed', attempts: attempt, error: (err as Error).message.slice(0, 300) })
    throw err
  }
  await recordOutcome(eventId, agentKey, { status: 'succeeded', attempts: attempt })
  return { status: 'succeeded', agentKey, type: row.type }
}

// ---------------------------------------------------------------- the 15-minute sweep

export const SWEEP_MS = 15 * 60_000
/** The 15-minute window a time falls in (the sweep's dedupe id). */
export const sweepSlot = (now: Date) => new Date(Math.floor(now.getTime() / SWEEP_MS) * SWEEP_MS).toISOString()

/** One 'sweep' event per active organization for this window (merchant, not deleted, agents not stopped). Idempotent per window. */
export async function emitSweep(now = new Date(), opts: { limit?: number } = {}): Promise<{ slot: string; orgs: number; routed: number; duplicates: number; jobs: number }> {
  const { admin } = await import('../db')
  const slot = sweepSlot(now)
  const orgs = await admin(db => db.query<{ id: string }>(
    `select a.id from agencies a left join org_controls c on c.org_id = a.id
     where a.org_type = 'merchant' and a.deleted_at is null and not coalesce(c.agents_stopped, false) order by a.created_at limit $1`, [opts.limit ?? 5000]))
  let routed = 0, duplicates = 0, jobs = 0
  const { inferFromConnections } = await import('../packs/settings')
  for (const o of orgs) {
    // a business connected before packs switched on by themselves gets them from its existing connections
    await admin(db => inferFromConnections(db, o.id)).catch(() => false)
    const r = await routeEvent({ source: 'sweep', type: 'sweep', orgId: o.id, externalId: `sweep:${slot}`, occurredAt: now.toISOString(), payload: { slot } })
    if (r.status === 'duplicate') duplicates++; else routed++
    jobs += r.jobs.length
  }
  return { slot, orgs: orgs.length, routed, duplicates, jobs }
}
