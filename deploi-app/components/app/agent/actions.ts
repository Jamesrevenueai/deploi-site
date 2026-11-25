'use server'
/**
 * Pause / resume from the agent dashboard. There is no /api/app endpoint for it, so this server action calls the
 * contract's pauseAgent / resumeAgent with the signed-in user (Next.js checks the action's origin; viewers are
 * read-only; the per-organization write limit applies, as in resolveActor) and returns the fresh dashboard.
 */
import { agentDashboard, pauseAgent, resumeAgent, type AgentDashboard } from '@/lib/app/contract'
import { isEngineError } from '@/lib/engine/errors'
import { hit } from '@/lib/security/rate-limit'
import { sessionActor, agentIdFrom } from './actor'

export type PauseResult = { ok: true; dashboard: AgentDashboard } | { ok: false; message: string }

export async function setAgentPaused(rawId: string, paused: boolean): Promise<PauseResult> {
  const actor = await sessionActor()
  if (!actor) return { ok: false, message: 'Sign in to a store account to change this agent.' }
  if (actor.session.orgRole === 'viewer') return { ok: false, message: 'Your role (viewer) is read-only; ask an owner or admin.' }
  const id = agentIdFrom(rawId)
  if (!id) return { ok: false, message: 'This agent was not found.' }
  if (!(await hit('merchant_write', `org:${actor.orgId}`)).allowed) return { ok: false, message: 'Too many changes at once; try again in a minute.' }
  try {
    if (paused) await pauseAgent(actor, id)
    else await resumeAgent(actor, id)
    return { ok: true, dashboard: await agentDashboard(actor, id) }
  } catch (e) {
    if (isEngineError(e)) return { ok: false, message: e.code === 'forbidden' ? 'Only owners and admins can pause or resume an agent.' : e.message }
    return { ok: false, message: 'Something went wrong; nothing was changed.' }
  }
}
