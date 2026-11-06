/**
 * Hand an AgentEvent (e.g. { source: 'crew', type: 'crew.done' }) to the event router so the next step runs
 * (for example: invoice the customer once the crew has finished the job).
 *
 * ADAPTER: lib/events (owned by W1) exports onEvent/handlersFor in this build but no routeEvent yet. When it
 * exports routeEvent (with its dedupe by source + externalId), that is used; until then the handlers
 * registered for the type are called directly. W1's router can replace this file's fallback without any change
 * for callers. A handler that throws is logged and never undoes what the crew member reported.
 */
import { admin, type Db } from '../db'
import { log } from '../log'
import * as events from '../events'
import type { AgentEvent } from '../events'

type Router = ((e: AgentEvent) => Promise<unknown>) | ((db: Db, e: AgentEvent) => Promise<unknown>)

export async function emitAgentEvent(e: AgentEvent): Promise<{ routed: 'router' | 'handlers'; handlers: number; errors: number }> {
  const route = (events as unknown as { routeEvent?: Router }).routeEvent
  if (typeof route === 'function') {
    try {
      await (route.length >= 2 ? admin(db => (route as (db: Db, e: AgentEvent) => Promise<unknown>)(db, e)) : (route as (e: AgentEvent) => Promise<unknown>)(e))
      return { routed: 'router', handlers: 0, errors: 0 }
    } catch (err) {
      log.warn('notify.event.route_failed', { type: e.type, error: (err as Error).message.slice(0, 200) })
      return { routed: 'router', handlers: 0, errors: 1 }
    }
  }
  const hs = events.handlersFor(e.type)
  let errors = 0
  for (const h of hs) {
    try { await admin(db => h.fn(db, e)) } catch (err) {
      errors++
      log.warn('notify.event.handler_failed', { type: e.type, agent: h.agentKey, error: (err as Error).message.slice(0, 200) })
    }
  }
  return { routed: 'handlers', handlers: hs.length, errors }
}
