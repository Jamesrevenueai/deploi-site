/**
 * Provider changes -> agent events (adapter). Every change a connection notices (new Outlook mail, a calendar
 * change, a CRM person created or edited, a QuickBooks invoice or payment, a Buildium work order, lease or
 * application) becomes one AgentEvent (lib/events). It is recorded once per (organization, source, externalId) in
 * connection_events, so a change seen twice (a repeated poll, a delta replay, a push and a poll) reaches the agents
 * once. Only ids and times are recorded; the payload goes to the handlers and is not stored here.
 *
 * W1 owns the event router (routeEvent). Until it is in this branch, emitConnectionEvent dedupes here and hands the
 * event to every handler registered with onEvent (handlersFor). When routeEvent lands, this function forwards to it
 * after the dedupe; its signature stays the same for the callers in this workstream.
 */
import type { Db } from '../db'
import { handlersFor, type AgentEvent } from '../events'
import { log } from '../log'

export type ConnectionEvent = AgentEvent & { connectionId?: string | null }
export type EmitResult = 'emitted' | 'duplicate'

/** Sources a connection may emit (the connection_events check constraint lists the same). */
export const CONNECTION_SOURCES = ['outlook', 'calendar', 'crm', 'quickbooks', 'buildium', 'mailbox'] as const

export async function emitConnectionEvent(db: Db, e: ConnectionEvent): Promise<EmitResult> {
  if (!(CONNECTION_SOURCES as readonly string[]).includes(e.source)) throw new Error(`not a connection event source: ${e.source}`)
  const externalId = e.externalId.slice(0, 400)
  const row = await db.one<{ id: string }>(`insert into connection_events (org_id, source, type, external_id, connection_id, occurred_at) values ($1,$2,$3,$4,$5,$6)
    on conflict (org_id, source, external_id) do nothing returning id`, [e.orgId, e.source, e.type, externalId, e.connectionId ?? null, e.occurredAt])
  if (!row) return 'duplicate'
  const event: AgentEvent = { source: e.source, type: e.type, orgId: e.orgId, externalId, occurredAt: e.occurredAt, payload: e.payload }
  let ran = 0
  for (const h of handlersFor(e.type)) {
    // one handler failing never stops the others, and never un-records the event (the sweep catches up)
    // a savepoint keeps a failed handler's writes (and an aborted statement) from undoing the caller's transaction
    await db.query('savepoint connection_event_handler')
    try { await h.fn(db, event); ran++; await db.query('release savepoint connection_event_handler') } catch (err) {
      await db.query('rollback to savepoint connection_event_handler')
      log.warn('connections.event_handler_failed', { type: e.type, agent: h.agentKey, error: (err as Error).message.slice(0, 160) })
    }
  }
  if (ran) await db.query('update connection_events set handlers = $2 where id = $1', [row.id, ran])
  return 'emitted'
}
