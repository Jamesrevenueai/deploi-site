/**
 * Plain-language tasks assigned to an existing agent. The text is parsed (deterministically, never
 * granting anything) and compared with the agent's granted rules:
 *  - within the rules        -> queued, then run under the current authorization version;
 *  - outside the rules       -> needs_approval: the merchant widens the agent (a new grant); the task is
 *                               re-checked automatically when that grant is made;
 *  - nothing Deploi can do,
 *    or nothing understood   -> refused: when unsure, the agent does nothing and says why.
 * Statuses are honest: "done" needs a finished run and its counts as proof; a run that leaves changes or
 * messages waiting is "waiting_on_you"; a failed or blocked run is "failed".
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { parseTask, type TaskDraft } from './parse'
import { parsePolicy, permissionRank, recipientAllowed, type AgentPolicy } from './policy'
import { runAgent, type AgentRunResult } from './run'

export type TaskStatus = 'needs_approval' | 'queued' | 'running' | 'done' | 'waiting_on_you' | 'failed' | 'refused' | 'cancelled'
export type AgentTaskRow = {
  id: string; org_id: string; agent_id: string; text: string; status: TaskStatus; status_reason: string | null; draft: TaskDraft; outside_rules: string[]
  policy_id: string | null; policy_version: number | null; run_id: string | null; proof: Record<string, unknown> | null
  created_by: string; decided_by: string | null; decided_at: string | null; created_at: string; updated_at: string; finished_at: string | null
}

/** What in the task the agent's granted policy does not cover. Empty = within the rules. */
export function outsideRules(d: TaskDraft, p: AgentPolicy | null): string[] {
  if (!p) return ['the agent has no granted authorization yet']
  const r: string[] = []
  for (const t of d.correctionTypes) if (!p.correctionTypes.includes(t)) r.push(`correcting ${t.replace('_', ' ')} is not in the agent's rules`)
  if (d.productScope.mode === 'all' && p.productScope.mode !== 'all') r.push("the task covers all products; the agent's scope is narrower")
  if (d.productScope.mode === 'tags' && p.productScope.mode === 'tags' && d.productScope.tags.some(t => !p.productScope.tags.includes(t))) r.push("the task names tags outside the agent's scope")
  if (d.productScope.mode === 'tags' && p.productScope.mode === 'products') r.push("the task names tags; the agent works only on listed products")
  const rank = { draft: 0, review: 1, autonomous: 2 } as const
  if (d.approvalMode && rank[d.approvalMode] > rank[p.approvalMode]) r.push(`the task asks to ${d.approvalMode === 'autonomous' ? 'act without asking' : 'make changes'}; the agent is ${p.approvalMode === 'draft' ? 'drafts only' : 'in review mode'}`)
  if (d.competitor && !p.competitors) r.push('the agent does not watch competitor stores')
  if (d.email) {
    if (!p.email) r.push('the agent is not authorized to use email')
    else {
      for (const t of d.email.tasks) if (!p.email.tasks.includes(t)) r.push(`the email task "${t.replace('_', ' ')}" is not in the agent's rules`)
      if (d.email.permission && permissionRank(d.email.permission) > permissionRank(p.email.permission)) r.push('the task asks for more email permission than the agent has')
      for (const a of d.email.addresses) if (!recipientAllowed(p.email, a)) r.push(`${a} is not an allowed recipient`)
    }
  }
  return [...new Set(r)]
}

function decide(d: TaskDraft, p: AgentPolicy | null): { status: TaskStatus; reason: string; outside: string[] } {
  // a schedule or a product scope alone says when or where, not what: not enough to run anything
  const understood = d.correctionTypes.length > 0 || Boolean(d.email) || d.productScope.mode !== null || Boolean(d.competitor)
  if (!understood && d.unsupported.length) return { status: 'refused', reason: `Deploi cannot do this: ${d.unsupported.join('; ')}`, outside: [] }
  // asking what competitors sell is the whole task, not a part that can be left out
  if (d.competitor && !d.correctionTypes.length && !d.email && d.unsupported.some(u => u.startsWith("another store's sales"))) return { status: 'refused', reason: `Deploi cannot do this: ${d.unsupported.join('; ')}. It can report what competitors publicly list, price, discount and feature.`, outside: [] }
  if (!understood) return { status: 'refused', reason: 'Deploi could not tell what to do from this text, so nothing will run. Name what to check or correct (for example prices, SKUs, overselling or publication) or the email to draft.', outside: [] }
  const outside = outsideRules(d, p)
  const note = d.unsupported.length ? ` Left out (Deploi cannot do it): ${d.unsupported.join('; ')}.` : ''
  if (outside.length) return { status: 'needs_approval', reason: `Outside the agent's granted rules: ${outside.join('; ')}. Widen the agent (a new grant) or cancel the task.${note}`, outside }
  return { status: 'queued', reason: `Within the agent's granted rules.${note}`, outside: [] }
}

async function activePolicy(db: Db, agentId: string): Promise<{ id: string; version: number; policy: AgentPolicy; agentStatus: string } | null> {
  const r = await db.one<{ id: string; version: number; policy: unknown; status: string }>(
    `select p.id, p.version, p.policy, a.status from agents a join agent_policies p on p.id = a.active_policy_id and p.status = 'active' where a.id = $1`, [agentId])
  return r ? { id: r.id, version: r.version, policy: parsePolicy(r.policy), agentStatus: r.status } : null
}

export async function assignTask(actor: Actor, agentId: string, text: string): Promise<AgentTaskRow> {
  const t = text.trim()
  if (!t || t.length > 2000) throw new EngineError('invalid_input', 'describe the task in 1 to 2000 characters')
  const a = await withActor(actor, db => db.one<{ id: string; org_id: string; status: string }>('select id, org_id, status from agents where id = $1', [agentId]))
  if (!a || a.status === 'deleted') throw new EngineError('not_found', 'agent not found')
  assertMerchant(actor, a.org_id)
  return admin(async db => {
    const pol = await activePolicy(db, agentId)
    const draft = parseTask(t)
    const d = decide(draft, pol?.policy ?? null)
    const row = (await db.one<AgentTaskRow>(`insert into agent_tasks (org_id, agent_id, text, status, status_reason, draft, outside_rules, policy_id, policy_version, created_by, finished_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, case when $4 = 'refused' then now() else null end) returning *`,
      [a.org_id, agentId, t, d.status, d.reason, JSON.stringify(draft), JSON.stringify(d.outside), pol?.id ?? null, pol?.version ?? null, actor.label]))!
    await audit(db, { orgId: a.org_id, entityType: 'agent', entityId: agentId, event: `task.${d.status}`, actor: actor.label,
      detail: { agent_id: agentId, task_id: row.id, policy_version: pol?.version ?? null, reason: d.reason, outside_rules: d.outside } })
    return row
  })
}

/** Re-check tasks waiting for approval against the agent's current grant (called after a grant). */
export async function recheckTasks(db: Db, agentId: string, actor: string): Promise<number> {
  const waiting = await db.query<AgentTaskRow>(`select * from agent_tasks where agent_id = $1 and status = 'needs_approval' for update`, [agentId])
  if (!waiting.length) return 0
  const pol = await activePolicy(db, agentId)
  let moved = 0
  for (const w of waiting) {
    const d = decide(w.draft, pol?.policy ?? null)
    if (d.status !== 'queued') continue
    await db.query(`update agent_tasks set status = 'queued', status_reason = $2, outside_rules = '[]', policy_id = $3, policy_version = $4, decided_by = $5, decided_at = now() where id = $1`,
      [w.id, `Now within the agent's rules (authorization version ${pol!.version}).`, pol!.id, pol!.version, actor])
    await audit(db, { orgId: w.org_id, entityType: 'agent', entityId: agentId, event: 'task.queued', actor, detail: { agent_id: agentId, task_id: w.id, policy_version: pol!.version, reason: 'covered by the new grant' } })
    moved++
  }
  return moved
}

export async function cancelTask(actor: Actor, taskId: string) {
  const t = await withActor(actor, db => db.one<{ id: string; org_id: string; agent_id: string }>('select id, org_id, agent_id from agent_tasks where id = $1', [taskId]))
  if (!t) throw new EngineError('not_found', 'task not found')
  assertMerchant(actor, t.org_id)
  return admin(async db => {
    const r = await db.query(`update agent_tasks set status = 'cancelled', status_reason = 'cancelled by you', finished_at = now() where id = $1 and status in ('needs_approval','queued') returning id`, [taskId])
    if (!r.length) throw new EngineError('not_pending', 'only a task that has not started can be cancelled')
    await audit(db, { orgId: t.org_id, entityType: 'agent', entityId: t.agent_id, event: 'task.cancelled', actor: actor.label, detail: { agent_id: t.agent_id, task_id: taskId } })
  })
}

/** Honest outcome of a run for a task: done only with proof and nothing left waiting. */
export function taskOutcome(r: Pick<AgentRunResult, 'status' | 'reason' | 'counts' | 'runId'>): { status: TaskStatus; reason: string; proof: Record<string, unknown> } {
  const c = r.counts
  const proof = { run_id: r.runId, run_status: r.status, verified: c.verified, failed: c.failed, blocked: c.blocked, awaiting_approval: c.awaitingApproval, drafted: c.drafted ?? 0,
    needs_person: c.needsPerson, issues_found: c.issuesFound, email: c.email ?? null, competitors: c.competitors ?? null }
  if (r.status !== 'completed') return { status: 'failed', reason: `The run ${r.status}: ${r.reason ?? 'no reason given'}. Nothing more was done.`, proof }
  if (c.failed > 0 || c.unconfirmed > 0) return { status: 'failed', reason: `${c.failed} change(s) failed and ${c.unconfirmed} could not be confirmed. See the work log.`, proof }
  const emailWaiting = (c.email?.emailAwaiting ?? 0) + (c.email?.emailDrafted ?? 0) + (c.email?.emailUnknown ?? 0)
  const waiting = c.awaitingApproval + (c.drafted ?? 0) + emailWaiting + c.needsPerson
  if (waiting > 0) return { status: 'waiting_on_you', reason: `Run finished. Waiting on you: ${[c.awaitingApproval && `${c.awaitingApproval} change(s) to approve`, c.drafted && `${c.drafted} drafted change(s) to read`, emailWaiting && `${emailWaiting} email(s) to review`, c.needsPerson && `${c.needsPerson} item(s) that need a person`].filter(Boolean).join(', ')}.`, proof }
  const k = c.competitors
  const store = `${c.verified} change(s) verified by a fresh read, ${c.issuesFound} issue(s) found`
  const comp = k ? `read the public pages of ${k.storesChecked} competitor store(s)${k.storesSkipped ? ` (${k.storesSkipped} skipped)` : ''}, ${k.findings} new finding(s)` : ''
  return { status: 'done', reason: `Run finished: ${[k && !c.verified && !c.issuesFound ? '' : store, comp].filter(Boolean).join('; ')}${c.email ? `, ${c.email.emailAccepted} email(s) accepted by the provider` : ''}.`, proof }
}

/** Run one queued task now (or leave it queued, honestly, while the agent is paused). */
export async function runTask(taskId: string, opts: { actor: string; now?: Date }): Promise<AgentTaskRow> {
  const claim = await admin(async db => {
    const t = await db.one<AgentTaskRow>(`select * from agent_tasks where id = $1 for update`, [taskId])
    if (!t) throw new EngineError('not_found', 'task not found')
    if (t.status !== 'queued') return { kind: 'skip' as const, t }
    const agent = await db.one<{ status: string }>('select status from agents where id = $1', [t.agent_id])
    if (agent?.status !== 'active') {
      await db.query(`update agent_tasks set status_reason = $2 where id = $1`, [t.id, `Queued: the agent is ${agent?.status ?? 'deleted'}; it runs when the agent is active again.`])
      return { kind: 'skip' as const, t: (await db.one<AgentTaskRow>('select * from agent_tasks where id = $1', [t.id]))! }
    }
    // the task runs only under the authorization version it was checked against
    const pol = await activePolicy(db, t.agent_id)
    const d = decide(t.draft, pol?.policy ?? null)
    if (!pol || d.status !== 'queued') {
      await db.query(`update agent_tasks set status = $2, status_reason = $3, outside_rules = $4 where id = $1`, [t.id, d.status === 'refused' ? 'refused' : 'needs_approval', d.reason, JSON.stringify(d.outside)])
      return { kind: 'skip' as const, t: (await db.one<AgentTaskRow>('select * from agent_tasks where id = $1', [t.id]))! }
    }
    await db.query(`update agent_tasks set status = 'running', status_reason = 'running', policy_id = $2, policy_version = $3 where id = $1`, [t.id, pol.id, pol.version])
    await audit(db, { orgId: t.org_id, entityType: 'agent', entityId: t.agent_id, event: 'task.running', actor: opts.actor, detail: { agent_id: t.agent_id, task_id: t.id, policy_version: pol.version } })
    return { kind: 'run' as const, t }
  })
  if (claim.kind === 'skip') return claim.t
  const t = claim.t
  let result: Pick<AgentRunResult, 'status' | 'reason' | 'counts' | 'runId'>
  try { result = await runAgent(t.agent_id, { trigger: 'manual', actor: opts.actor, now: opts.now }) } catch (e) {
    result = { runId: '', status: 'failed', reason: (e as Error).message.slice(0, 200), counts: { issuesFound: 0, needsPerson: 0, proposed: 0, autoApproved: 0, awaitingApproval: 0, verified: 0, failed: 0, blocked: 0, stale: 0, unconfirmed: 0, missingSources: [] } }
  }
  const o = taskOutcome(result)
  return admin(async db => {
    const row = (await db.one<AgentTaskRow>(`update agent_tasks set status = $2, status_reason = $3, proof = $4, run_id = $5, finished_at = now() where id = $1 returning *`,
      [t.id, o.status, o.reason, JSON.stringify(o.proof), result.runId || null]))!
    await audit(db, { orgId: t.org_id, entityType: 'agent', entityId: t.agent_id, event: `task.${o.status}`, actor: opts.actor, detail: { agent_id: t.agent_id, task_id: t.id, run_id: result.runId || null, policy_version: row.policy_version, reason: o.reason, proof: o.proof } })
    return row
  })
}

/** Scheduler: run queued tasks whose agent is active. */
export async function runQueuedTasks(opts: { actor?: string; limit?: number } = {}) {
  const due = await admin(db => db.query<{ id: string }>(`select t.id from agent_tasks t join agents a on a.id = t.agent_id where t.status = 'queued' and a.status = 'active' order by t.created_at limit $1`, [opts.limit ?? 20]))
  const out: { id: string; status: TaskStatus }[] = []
  for (const d of due) {
    try { const r = await runTask(d.id, { actor: opts.actor ?? 'system:scheduler' }); out.push({ id: r.id, status: r.status }) } catch { out.push({ id: d.id, status: 'failed' }) }
  }
  return out
}

export async function listTasks(actor: Actor, agentId: string): Promise<AgentTaskRow[]> {
  return withActor(actor, db => db.query<AgentTaskRow>('select * from agent_tasks where agent_id = $1 order by created_at desc limit 50', [agentId]))
}
