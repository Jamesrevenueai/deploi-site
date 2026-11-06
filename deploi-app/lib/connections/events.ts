/**
 * Provider changes -> agent events (adapter). Every change a connection notices (new Outlook mail, a calendar
 * change, a CRM person created or edited, a QuickBooks invoice or payment, a Buildium work order, lease or
 * application) becomes one AgentEvent (lib/events). It is recorded once per (organization, source, externalId) in
 * connection_events, so a change seen twice (a repeated poll, a delta replay, a push and a poll) reaches the agents
 * once. Only ids and times are recorded; the payload goes to the handlers and is not stored here.
 *
 * After the dedupe the event goes to the router (routeEvent), which records it in agent_events and queues one durable
 * agent job per handler; a failing agent retries in the job queue and never un-records the event.
 */
import type { Db } from '../db'
import type { AgentEvent } from '../events'
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
  // the router records the event in agent_events and queues one durable job per agent that handles it (lib/events)
  const { routeEvent } = await import('../events')
  const routed = await routeEvent(event, { db })
  if (routed.handlers.length) await db.query('update connection_events set handlers = $2 where id = $1', [row.id, routed.handlers.length])
  log.info('connections.event_routed', { type: e.type, status: routed.status, handlers: routed.handlers.length })
  for (const alias of packEvents(e)) await emitConnectionEvent(db, alias)
  return 'emitted'
}

/**
 * The agent packs (lib/packs) listen for business events, the connections report provider changes. This maps one to
 * the other, deduped like any event: a new person in a CRM -> crm.lead.created (once per person), a QuickBooks
 * invoice or payment change -> quickbooks.invoice / quickbooks.payment, a Buildium resident request seen for the first
 * time -> buildium.maintenance.created (once per request).
 * Limit: a payment change carries the QuickBooks payment id only (no invoice number or amount), so the leasing
 * payment recorder ignores it until a QuickBooks payment read fills those in; the Office receivables agent rereads
 * QuickBooks itself and is not affected.
 */
export function packEvents(e: ConnectionEvent): ConnectionEvent[] {
  const p = e.payload as Record<string, unknown>
  const base = { source: e.source, orgId: e.orgId, occurredAt: e.occurredAt, connectionId: e.connectionId ?? null }
  if (e.type === 'crm.contact.changed') {
    const c = p.contact as { id?: string; kind?: string } | undefined
    if (!c?.id) return []
    return [{ ...base, type: 'crm.lead.created', externalId: `lead:${String(p.provider)}:${c.kind ?? 'contact'}:${c.id}`, payload: { provider: p.provider, connectionId: e.connectionId, contact: c } }]
  }
  if (e.type === 'invoice.changed') return [{ ...base, type: 'quickbooks.invoice', externalId: `pack:${e.externalId}`, payload: { invoiceId: p.id, deleted: p.deleted, connectionId: e.connectionId } }]
  if (e.type === 'payment.changed') return p.deleted ? [] : [{ ...base, type: 'quickbooks.payment', externalId: `pack:${e.externalId}`, payload: { paymentId: p.id, connectionId: e.connectionId } }]
  // a resident request is the tenant's maintenance request; a work order is a job the manager (or the vendor
  // dispatcher) already created from one, so it is not a new request
  if (e.type === 'buildium.request.changed') {
    const r = p.record as { id?: string | number } | undefined
    if (r?.id == null) return []
    return [{ ...base, type: 'buildium.maintenance.created', externalId: `maintenance:request:${r.id}`, payload: { requestId: String(r.id), connectionId: e.connectionId } }]
  }
  return []
}
