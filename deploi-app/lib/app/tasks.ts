/**
 * Delegating work to an agent. A task the owner gives an agent is a case (lib/cases: kind owner_task, source
 * deploi) owned by that agent, so it shows on the agent's page, in the team room and in the proof log exactly like the
 * work the agent found itself, with its own case reference.
 *
 * What happens next, rules only (AI is off):
 *   1. the agent takes it (case -> investigating, "Picked up by ...") and runs its check now (an org sweep through the
 *      event router, deduped per task), so whatever it can prepare from its own jobs lands in Needs you for a yes/no;
 *   2. it says plainly what it can and cannot do without AI: it never claims to have done free-text work it cannot do;
 *   3. the owner closes the task: "done" resolves the case with the owner's confirmation as the evidence, "cancel"
 *      cancels it. Money still always waits for the owner (the task grants nothing: no permission moves with it).
 */
import { admin, type Db } from '../db'
import type { Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { audit } from '../engine/audit'
import { assertCan } from '../platform/rbac'
import { openCase, resolveCase, transitionCase, addNote, type CaseRow, TERMINAL } from '../cases'
import { findAgent, merchantOrg } from './feeds'
import { AGENT_REF } from './profiles'
import type { AgentSource } from './team'

export const TASK_KIND = 'owner_task'
export const TASK_MAX = 500
export type DelegatedTask = { ref: string; caseId: string; agentId: string; agentName: string; text: string; status: string; reply: string; checkStarted: boolean }

/** The case owner for a team agent (the same mapping lib/app/team.ts refOfCase reads back). */
function ownerOf(src: AgentSource): { agent: { kind: 'library' | 'engine' | 'office'; ref: string } | null; records: { type: string; id: string; label?: string }[] } {
  if (src.kind === 'store' && src.loopKey) return { agent: { kind: 'library', ref: src.key }, records: [] }
  if (src.kind === 'store' && src.engineAgentId) return { agent: { kind: 'engine', ref: src.engineAgentId }, records: [] }
  if (src.kind === 'office' && src.officeAgentId) return { agent: { kind: 'office', ref: src.officeAgentId }, records: [] }
  if (src.loopKey) return { agent: null, records: [{ type: 'agent', id: src.loopKey, label: src.name }] }
  throw new EngineError('invalid_input', 'this agent cannot take tasks')
}

/** Plain words on what the agent will do with a task, from what it really can do. */
export function taskReply(name: string, on: boolean, jobs: string[]): string {
  if (!on) return `${name} is off, so it will not start this until you switch it back on. The task is saved on its page.`
  const can = jobs.length ? ` What I can do on my own: ${jobs.slice(0, 4).join('; ')}.` : ''
  return `${name}: got it. I am running my check now; anything I prepare from it comes to Needs you for your yes or no.${can} Free-text work beyond my jobs needs AI, which is off, so mark this task done when it is handled.`
}

export async function delegateTask(actor: Actor, agentId: string, text: unknown, opts: { now?: Date } = {}): Promise<DelegatedTask> {
  const orgId = merchantOrg(actor)
  await assertCan(actor, orgId, 'approve')
  if (!AGENT_REF.test(agentId)) throw new EngineError('not_found', 'agent not found')
  if (typeof text !== 'string' || !text.replace(/\u0000/g, '').trim()) throw new EngineError('invalid_input', 'say what the task is')
  const t = text.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim()
  if (t.length > TASK_MAX) throw new EngineError('invalid_input', `a task is at most ${TASK_MAX} characters`)
  const now = opts.now ?? new Date()
  const res = await admin(async db => {
    const { src } = await findAgent(db, orgId, agentId)
    const owner = ownerOf(src)
    const id = crypto.randomUUID()
    const title = t.length > 120 ? `${t.slice(0, 117)}...` : t
    const { case: c } = await openCase(db, {
      orgId, suite: src.workspace === 'store' ? 'commerce' : 'office', kind: TASK_KIND, sourceApp: 'deploi', dedupeKey: `task:${id}`,
      title: title.length >= 3 ? title : `Task: ${title}`, problem: t, whyItMatters: 'You asked for it', agent: owner.agent, records: owner.records,
      verification: { criteria: 'You confirm the task is done' }, nextAction: `${src.name} works on it`, actor: actor.label,
    })
    const reply = taskReply(src.name, src.on, src.actions.length ? src.actions.map(a => a.replace(/[_.]/g, ' ')) : [src.job])
    let row: CaseRow = c
    if (src.on) row = await transitionCase(db, c.id, { to: 'investigating', actor: `agent:${src.id}`.slice(0, 160), reason: `Picked up by ${src.name}` })
    await addNote(db, c.id, reply, `agent:${src.id}`.slice(0, 160))
    await audit(db, { orgId, entityType: 'case', entityId: c.id, event: 'app.task_delegated', actor: actor.label, detail: { agent: agentId, ref: c.ref } })
    return { c: row, src, reply }
  })
  let checkStarted = false
  if (res.src.on) {
    try {
      const { routeEvent } = await import('../events')
      const ev = await routeEvent({ source: 'sweep', type: 'sweep', orgId, externalId: `task:${res.c.id}`, occurredAt: now.toISOString(), payload: { task: res.c.ref, agent: agentId } })
      checkStarted = ev.status !== 'refused' && ev.jobs.length > 0
    } catch { checkStarted = false }
  }
  return { ref: res.c.ref, caseId: res.c.id, agentId, agentName: res.src.name, text: t, status: res.c.status, reply: res.reply, checkStarted }
}

async function taskCase(db: Db, orgId: string, ref: string): Promise<CaseRow> {
  const c = await db.one<CaseRow>('select * from cases where org_id = $1 and (ref = $2 or id::text = $2) and kind = $3', [orgId, ref, TASK_KIND])
  if (!c) throw new EngineError('not_found', 'task not found')
  return c
}

/** The owner closes a task: done (resolved, with their confirmation as the evidence) or cancel. */
export async function finishTask(actor: Actor, ref: string, op: unknown): Promise<{ ref: string; status: 'resolved' | 'cancelled' }> {
  const orgId = merchantOrg(actor)
  await assertCan(actor, orgId, 'approve')
  if (op !== 'done' && op !== 'cancel') throw new EngineError('invalid_input', 'op must be done or cancel')
  if (typeof ref !== 'string' || !/^[A-Za-z0-9-]{3,40}$/.test(ref)) throw new EngineError('not_found', 'task not found')
  return admin(async db => {
    const c = await taskCase(db, orgId, ref)
    if (TERMINAL.includes(c.status)) throw new EngineError('not_pending', `the task is already ${c.status === 'resolved' ? 'done' : 'cancelled'}`)
    if (op === 'done') {
      await resolveCase(db, c.id, { actor: actor.label, summary: `Done: ${c.title}`, verifiedBy: 'owner', evidence: [{ label: 'You confirmed the task is done', source: 'owner', observedAt: new Date().toISOString() }] }, { orgId })
      return { ref: c.ref, status: 'resolved' as const }
    }
    await transitionCase(db, c.id, { to: 'cancelled', actor: actor.label, reason: 'Cancelled by you' }, { orgId })
    return { ref: c.ref, status: 'cancelled' as const }
  })
}
