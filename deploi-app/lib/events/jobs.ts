/**
 * Durable jobs of the event router and the agent loop (importing this module registers them):
 *   event.handle  one agent's handler for one routed event (lib/events/index.ts); retried with backoff, 5 attempts
 *   loop.resume   carry out an action the owner approved (lib/events/loop.ts), through the agent's resumer
 */
import { registerJobHandler } from '../jobs/queue'
import { EVENT_JOB, handleStoredEvent } from './index'
import { LOOP_RESUME_JOB, resumeLoop } from './loop'

const UUID = /^[0-9a-f-]{36}$/i

registerJobHandler(EVENT_JOB, async (payload, ctx) => {
  const eventId = String(payload.eventId ?? '')
  const agentKey = String(payload.agentKey ?? '')
  if (!UUID.test(eventId) || !agentKey) return { skipped: true, reason: 'invalid event job' }
  return handleStoredEvent(eventId, agentKey, ctx.job.org_id, ctx.job.attempts)
}, { leaseMs: 5 * 60_000, maxAttempts: 5 })

registerJobHandler(LOOP_RESUME_JOB, async (payload, ctx) => {
  const loopId = String(payload.loopId ?? '')
  if (!UUID.test(loopId)) return { skipped: true, reason: 'invalid loop id' }
  return resumeLoop(loopId, ctx.job.org_id)
}, { leaseMs: 5 * 60_000, maxAttempts: 3 })
