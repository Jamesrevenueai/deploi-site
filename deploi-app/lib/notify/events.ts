/**
 * Hand an AgentEvent (e.g. { source: 'crew', type: 'crew.done' }) to the event router so the next step runs
 * (for example: invoice the customer once the crew has finished the job). The router (lib/events routeEvent)
 * dedupes by source + externalId and queues one durable job per handler. A routing failure is logged and never
 * undoes what the crew member reported.
 */
import { log } from '../log'
import { routeEvent, type AgentEvent } from '../events'

export async function emitAgentEvent(e: AgentEvent): Promise<{ routed: 'router'; handlers: number; errors: number }> {
  try {
    const r = await routeEvent(e)
    return { routed: 'router', handlers: r.handlers.length, errors: 0 }
  } catch (err) {
    log.warn('notify.event.route_failed', { type: e.type, error: (err as Error).message.slice(0, 200) })
    return { routed: 'router', handlers: 0, errors: 1 }
  }
}
