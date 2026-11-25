/**
 * "Run a check now" on an agent's dashboard (design-ref/app-agent-dashboard.html): run the agent once, whatever its kind.
 *   store engine agent  -> lib/agents/run runAgent (detect, then act within its grants)
 *   store library agent -> lib/library/actions runLibraryAgent (its permission level decides drafts vs auto-run)
 *   office agent        -> lib/office/run runOfficeAgent
 *   pack agent          -> one manual sweep event for the organization (the pack agents' scheduled check, now)
 * Members and above (capability `approve`); viewers and staff cannot. Nothing runs for a paused or switched-off agent.
 */
import { admin } from '../db'
import type { Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { assertCan } from '../platform/rbac'
import { merchantOrg, findAgent } from './feeds'

export type RunCheckResult = { agentId: string; ran: 'engine' | 'library' | 'office' | 'sweep'; summary: string }

export async function runCheck(actor: Actor, id: string, opts: { now?: Date } = {}): Promise<RunCheckResult> {
  const orgId = merchantOrg(actor)
  await assertCan(actor, orgId, 'approve')
  const { src } = await admin(db => findAgent(db, orgId, id))
  if (!src.on) throw new EngineError('agent_inactive', `${src.name} is ${src.offReason ?? 'off'}; resume it first`)
  const now = opts.now ?? new Date()
  if (src.engineAgentId) {
    const { runAgent } = await import('../agents/run')
    const r = await runAgent(src.engineAgentId, { trigger: 'manual', actor: actor.label, now })
    return { agentId: id, ran: 'engine', summary: `Checked: ${JSON.stringify(r.counts ?? {})}` }
  }
  if (src.kind === 'store') {
    const { runLibraryAgent } = await import('../library/actions')
    const r = await runLibraryAgent({ orgId, agentKey: src.key, trigger: 'manual', actor: actor.label, now })
    const c = r.counts
    return { agentId: id, ran: 'library', summary: `Checked: ${c.done} done, ${c.drafted} drafted for you, ${c.noted} noted` }
  }
  if (src.officeAgentId) {
    const { runOfficeAgent } = await import('../office/run')
    await runOfficeAgent(src.officeAgentId, { trigger: 'manual', now })
    return { agentId: id, ran: 'office', summary: 'Checked' }
  }
  const { routeEvent } = await import('../events')
  const r = await routeEvent({ source: 'manual', type: 'sweep', orgId, externalId: `manual-check:${id}:${now.toISOString().slice(0, 16)}`, occurredAt: now.toISOString(), payload: { requestedBy: actor.label, agent: id } })
  return { agentId: id, ran: 'sweep', summary: r.status === 'duplicate' ? 'A check is already running' : 'Check started' }
}
