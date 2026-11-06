/**
 * Event router. SHARED INTERFACE — owned by workstream W1.
 * Every trigger (Shopify webhook, new Outlook mail or calendar event, CRM/QuickBooks/Buildium change, or the
 * 15-minute sweep) becomes one AgentEvent; the router dedupes it by (source, externalId) and hands it to every
 * handler registered for its type. Handlers run the agent loop: detect -> fix -> verify -> log proof -> notify.
 */
import type { Db } from '../db'

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
