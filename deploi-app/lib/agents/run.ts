/**
 * One agent run: scan the agent's scope with its active policy, then either leave each exact change
 * waiting for approval (review mode) or, in authorized autonomous mode, record a standing-authorization
 * approval for each change the policy covers (within its limits), queue the writes and execute them in
 * order. Each execution re-reads the record, re-qualifies against the authorization version it is bound
 * to, writes one field, and verifies with a fresh read. Changes the policy does not cover wait for the
 * merchant with the reason. Pausing or revoking mid-run closes the remaining queued writes.
 */
import { admin } from '../db'
import { audit } from '../engine/audit'
import { EngineError } from '../engine/errors'
import { runScan } from '../engine/scan'
import { executeProposal, queueExecution, type ExecutionResult } from '../engine/execute'
import type { ProposalRow } from '../engine/proposals'
import type { ResourceRecord } from '../engine/types'
import { loadAgentContext, qualifies, type AgentRow, type Qualification } from './plan'
import { nextRunAt } from './schedule'
import { runEmailStep, type EmailRunCounts } from '../email/run'

export type AgentRunTrigger = 'manual' | 'schedule' | 'webhook' | 'test'
export type AgentRunCounts = {
  issuesFound: number; needsPerson: number; proposed: number
  /** exact changes recorded by a drafts-only agent (never made) */
  drafted?: number
  autoApproved: number; awaitingApproval: number
  verified: number; failed: number; blocked: number; stale: number; unconfirmed: number
  missingSources: string[]
  email?: EmailRunCounts
}
export type AgentRunResult = { runId: string; status: 'completed' | 'failed' | 'blocked'; reason?: string; counts: AgentRunCounts; executions: ExecutionResult[] }

const STALE_RUN_MS = 15 * 60e3
const empty = (): AgentRunCounts => ({ issuesFound: 0, needsPerson: 0, proposed: 0, drafted: 0, autoApproved: 0, awaitingApproval: 0, verified: 0, failed: 0, blocked: 0, stale: 0, unconfirmed: 0, missingSources: [] })

export const agentActorLabel = (name: string, version: number) => `agent:${name}@v${version}`

export async function runAgent(agentId: string, opts: { trigger: AgentRunTrigger; actor: string; now?: Date }): Promise<AgentRunResult> {
  const now = opts.now ?? new Date()
  // claim: one run per agent at a time; the agent must be active with a granted authorization
  const claim = await admin(async db => {
    const agent = await db.one<AgentRow>('select * from agents where id = $1 for update', [agentId])
    if (!agent || agent.status === 'deleted') throw new EngineError('not_found', 'agent not found')
    if (agent.status !== 'active') throw new EngineError('agent_inactive', `the agent is ${agent.status}`)
    const running = await db.one<{ id: string; started_at: string }>(`select id, started_at from agent_runs where agent_id = $1 and status = 'running' order by started_at desc limit 1`, [agentId])
    if (running && now.getTime() - new Date(running.started_at).getTime() < STALE_RUN_MS) throw new EngineError('busy', 'this agent is already running')
    if (running) await db.query(`update agent_runs set status = 'failed', status_reason = 'did not finish', finished_at = now() where id = $1`, [running.id])
    const ctx = await loadAgentContext(db, agentId)
    if (!ctx) throw new EngineError('agent_inactive', 'the agent has no active authorization')
    const run = await db.one<{ id: string }>(`insert into agent_runs (org_id, agent_id, policy_id, policy_version, trigger) values ($1,$2,$3,$4,$5) returning id`,
      [agent.org_id, agentId, ctx.policyRow.id, ctx.policyRow.version, opts.trigger])
    await db.query('update agents set last_run_at = $2, next_run_at = $3 where id = $1', [agentId, now.toISOString(), nextRunAt(ctx.policy.schedule, now)?.toISOString() ?? null])
    await audit(db, { orgId: agent.org_id, connectionId: agent.connection_id, entityType: 'run', entityId: run!.id, event: 'agent_run.started', actor: opts.actor, detail: { agent_id: agentId, policy_version: ctx.policyRow.version, trigger: opts.trigger } })
    return { runId: run!.id, ctx }
  })
  const { runId, ctx } = claim
  const counts = empty()
  const executions: ExecutionResult[] = []
  const finishRun = async (status: AgentRunResult['status'], reason?: string, scanId?: string) => {
    await admin(async db => {
      await db.query(`update agent_runs set status = $2, status_reason = $3, counts = $4, scan_id = $5, finished_at = now() where id = $1`, [runId, status, reason ?? null, JSON.stringify(counts), scanId ?? null])
      await audit(db, { orgId: ctx.agent.org_id, connectionId: ctx.agent.connection_id, entityType: 'run', entityId: runId, event: `agent_run.${status}`, actor: opts.actor, detail: { reason: reason ?? null, counts } })
    })
    return { runId, status, reason, counts, executions }
  }

  const sourceIds = [ctx.policy.rules.price?.sourceId, ctx.policy.rules.sku?.sourceId, ctx.policy.rules.publication?.sourceId].filter((x): x is string => Boolean(x))
  counts.missingSources = sourceIds.filter(id => !ctx.plan.references[id])
  if (counts.missingSources.length && counts.missingSources.length === sourceIds.length && !ctx.policy.correctionTypes.some(t => t === 'oversell_policy' || (t === 'publication' && !ctx.policy.rules.publication?.sourceId)))
    return finishRun('blocked', 'the reference files this agent relies on are missing or archived')

  let scanId: string | undefined
  let records: ResourceRecord[] | null = null
  try {
    const scan = await runScan(ctx.agent.connection_id, { trigger: opts.trigger === 'test' ? 'test' : opts.trigger, actor: opts.actor, plan: ctx.plan, now, onRecords: r => { records = r } })
    scanId = scan.scanId
  } catch (e) {
    const reason = e instanceof EngineError ? e.message : `could not read the store: ${(e as Error).message.slice(0, 160)}`
    return finishRun(e instanceof EngineError ? 'blocked' : 'failed', reason)
  }

  const label = agentActorLabel(ctx.agent.name, ctx.policyRow.version)
  // decide each waiting change of this agent's current version
  const queued = await admin(async db => {
    const issues = await db.one<{ open: string; person: string }>(
      `select count(*) filter (where kind = 'correctable')::text as open, count(*) filter (where kind = 'needs_person')::text as person from issues where agent_id = $1 and status in ('open','needs_review')`, [agentId])
    counts.issuesFound = Number(issues?.open ?? 0) + Number(issues?.person ?? 0)
    counts.needsPerson = Number(issues?.person ?? 0)
    const proposals = await db.query<ProposalRow & { evidence: Record<string, unknown> }>(
      `select p.*, i.evidence from proposals p join issues i on i.id = p.issue_id
       where p.agent_id = $1 and p.policy_version = $2 and p.status = 'pending_approval' and p.expires_at > now() order by i.severity = 'high' desc, p.created_at`, [agentId, ctx.policyRow.version])
    counts.proposed = proposals.length
    if (ctx.policy.approvalMode === 'draft') {
      // drafts only: the exact changes are recorded for the merchant to read; none can be approved or made
      counts.drafted = proposals.length
      for (const p of proposals) await db.query(`update proposals set status_reason = $2 where id = $1`, [p.id, 'draft: this agent only shows changes; it may not make them'])
      return []
    }
    if (ctx.policy.approvalMode !== 'autonomous') { counts.awaitingApproval = proposals.length; return [] }
    const today = await db.one<{ n: string }>(
      `select count(*)::text as n from approvals a join proposals p on p.id = a.proposal_id where p.agent_id = $1 and a.approver_kind = 'standing_authorization'
       and a.approved_at >= date_trunc('day', now()) and a.revoked_at is null`, [agentId])
    let day = Number(today?.n ?? 0), run = 0
    const out: string[] = []
    for (const p of proposals) {
      const record = { resourceType: p.target_type, resourceId: p.target_id, fetchedAt: String(p.evidence.fetchedAt ?? ''), productId: p.evidence.productId, productTags: p.evidence.productTags } as ResourceRecord
      const q: Qualification = qualifies(ctx, { actionKey: p.action_key, change: p.change, record, counts: { run, day } })
      if (!q.covered) {
        counts.awaitingApproval++
        await db.query(`update proposals set status_reason = $2 where id = $1`, [p.id, `waiting for your approval: ${q.blockers.join('; ')}`])
        continue
      }
      const a = await db.one<{ id: string }>(
        `insert into approvals (org_id, proposal_id, change_hash, approved_by, approver_kind, approved_at, policy_id, policy_version, qualification) values ($1,$2,$3,$4,'standing_authorization',$5,$6,$7,$8) returning id`,
        [p.org_id, p.id, p.change_hash, label, now.toISOString(), ctx.policyRow.id, ctx.policyRow.version, JSON.stringify(q)])
      await db.query(`update proposals set status = 'approved', decided_at = $2, status_reason = 'covered by standing authorization' where id = $1`, [p.id, now.toISOString()])
      const execId = await queueExecution(db, p, a!.id)
      await audit(db, { orgId: p.org_id, connectionId: p.connection_id, entityType: 'approval', entityId: a!.id, event: 'approval.standing', actor: label,
        detail: { proposal_id: p.id, change_hash: p.change_hash, policy_id: ctx.policyRow.id, policy_version: ctx.policyRow.version, reasons: q.reasons, execution_id: execId } })
      run++; day++
      counts.autoApproved++
      out.push(p.id)
    }
    return out
  })

  // execute in order; each one re-checks the agent's status, so a pause or revoke stops the rest
  for (const proposalId of queued) {
    const r = await executeProposal(proposalId, { actor: label, now })
    executions.push(r)
    if (r.status === 'verified') counts.verified++
    else if (r.status === 'failed' || r.status === 'verification_failed') counts.failed++
    else if (r.status === 'blocked') counts.blocked++
    else if (r.status === 'stale') counts.stale++
    else counts.unconfirmed++
  }

  // email tasks run after the corrections, under the same authorization version
  if (ctx.policy.email) {
    const store = await admin(db => db.one<{ name: string }>('select coalesce(display_name, external_id) as name from store_connections where id = $1', [ctx.agent.connection_id]))
    try {
      counts.email = await runEmailStep({ agentId, agentName: ctx.agent.name, runId, policy: ctx.policy, storeName: store?.name ?? 'your store', records, actor: label, now,
        run: { verified: counts.verified, awaitingApproval: counts.awaitingApproval, needsPerson: counts.needsPerson, failed: counts.failed, blocked: counts.blocked } })
    } catch (e) {
      return finishRun('failed', `email step failed: ${(e as Error).message.slice(0, 160)}`, scanId)
    }
  }
  return finishRun('completed', undefined, scanId)
}

/** Scheduler: run every active agent that is due. Each agent runs at most once per call; failures are recorded per agent. */
export async function runDueAgents(opts: { now?: Date; limit?: number } = {}) {
  const now = opts.now ?? new Date()
  const due = await admin(db => db.query<{ id: string }>(
    `select a.id from agents a join store_connections c on c.id = a.connection_id
     where a.status = 'active' and a.next_run_at is not null and a.next_run_at <= $1 and c.status = 'active' order by a.next_run_at limit $2`, [now.toISOString(), opts.limit ?? 20]))
  const results: { agentId: string; status: string; reason?: string }[] = []
  for (const a of due) {
    try {
      const r = await runAgent(a.id, { trigger: 'schedule', actor: 'system:scheduler', now })
      results.push({ agentId: a.id, status: r.status, reason: r.reason })
    } catch (e) {
      results.push({ agentId: a.id, status: 'skipped', reason: (e as Error).message })
    }
  }
  return results
}
