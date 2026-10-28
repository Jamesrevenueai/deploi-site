/**
 * Execution of one approved proposal:
 *   claim (single winner) -> gates -> fresh read + recheck -> write -> verify by a fresh read.
 * One approval is consumed by at most one execution (idempotency key = approval id). Retries reuse
 * the same execution row and re-run the recheck, so a retry never writes twice and never writes
 * over a change somebody else made in between.
 */
import { admin } from '../db'
import { getConnector } from './registry'
import { changeHash, getPath, sameValue } from './hash'
import { audit } from './audit'
import { engineConfig, liveWritesAllowed } from './config'
import { EngineError } from './errors'
import { loadConnection, withOwner } from './scan'
import { legacyPlan, buildStoreContext, detectWithPlan, lookupKeysFor } from './plan'
import { loadAgentContext, qualifies, type Qualification } from '../agents/plan'
import { actionField, writableFields } from '../agents/policy'
import { invalidateProposal, type ProposalRow } from './proposals'
import { assertMerchant, withActor, type Actor } from './actor'
import type { ApplyResult, ConnectionRow, Correction, ResourceRecord } from './types'

export type ExecutionStatus = 'queued' | 'prechecking' | 'blocked' | 'stale' | 'executing' | 'applied' | 'unknown' | 'verified' | 'failed' | 'verification_failed'
export type ExecutionResult = { executionId: string | null; status: ExecutionStatus | 'not_approved'; reason?: string; duplicate?: boolean }

type ExecRow = { id: string; org_id: string; connection_id: string; proposal_id: string; approval_id: string; status: ExecutionStatus; attempt: number; is_synthetic: boolean }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export function correctionFromProposal(p: ProposalRow): Correction {
  const { params, ...change } = p.change as ProposalRow['change'] & { params?: Record<string, unknown> }
  return { actionKey: p.action_key, targetType: p.target_type, targetId: p.target_id, targetLabel: p.target_label ?? '', change, preconditions: p.preconditions, params }
}

/** Run an approved proposal. Safe to call more than once: later calls return the existing execution. */
export async function executeProposal(proposalId: string, opts: { actor: string; now?: Date } ): Promise<ExecutionResult> {
  const claim = await admin(async db => {
    const p = await db.one<ProposalRow>('select * from proposals where id = $1 for update', [proposalId])
    if (!p) throw new EngineError('not_found', 'proposal not found')
    const approval = await db.one<{ id: string; change_hash: string }>('select id, change_hash from approvals where proposal_id = $1 and revoked_at is null', [p.id])
    if (approval) {
      const existing = await db.one<ExecRow>('select * from executions where idempotency_key = $1', [approval.id])
      if (existing?.status === 'queued') {
        // a queued write starts only once, and only if pause or revoke has not closed it
        const started = await db.one<ExecRow>(`update executions set status = 'prechecking', started_at = now() where id = $1 and status = 'queued' returning *`, [existing.id])
        if (!started) return { kind: 'existing' as const, exec: (await db.one<ExecRow>('select * from executions where id = $1', [existing.id]))! }
        await db.query(`update proposals set status = 'executing' where id = $1`, [p.id])
        await audit(db, { orgId: p.org_id, connectionId: p.connection_id, entityType: 'execution', entityId: started.id, event: 'execution.started', actor: opts.actor, detail: { proposal_id: p.id, attempt: 1, from_queue: true } })
        return { kind: 'claimed' as const, exec: started }
      }
      if (existing) return { kind: 'existing' as const, exec: existing }
    }
    if (p.status !== 'approved' || !approval) return { kind: 'not_approved' as const, status: p.status }
    if (approval.change_hash !== p.change_hash) {
      await invalidateProposal(db, p, 'blocked', 'approval does not match the proposed change', opts.actor)
      return { kind: 'not_approved' as const, status: 'blocked' }
    }
    const conn = await loadConnection(db, p.connection_id)
    const exec = await db.one<ExecRow>(
      `insert into executions (org_id, connection_id, proposal_id, approval_id, idempotency_key, status, is_synthetic) values ($1,$2,$3,$4,$5,'prechecking',$6)
       on conflict (idempotency_key) do nothing returning *`,
      [p.org_id, p.connection_id, p.id, approval.id, String(approval.id), conn?.is_synthetic ?? false])
    if (!exec) return { kind: 'existing' as const, exec: (await db.one<ExecRow>('select * from executions where idempotency_key = $1', [approval.id]))! }
    await db.query(`update proposals set status = 'executing' where id = $1`, [p.id])
    await audit(db, { orgId: p.org_id, connectionId: p.connection_id, entityType: 'execution', entityId: exec.id, event: 'execution.started', actor: opts.actor, detail: { proposal_id: p.id, attempt: 1 } })
    return { kind: 'claimed' as const, exec }
  })
  if (claim.kind === 'not_approved') return { executionId: null, status: 'not_approved', reason: `proposal is ${claim.status}` }
  if (claim.kind === 'existing') return { executionId: claim.exec.id, status: claim.exec.status, duplicate: true }
  return runExecution(claim.exec.id, opts)
}

/** Queue the write for an approved proposal (agent runs queue first, then execute in order); idempotent per approval. */
export async function queueExecution(db: import('../db').Db, p: ProposalRow, approvalId: string): Promise<string> {
  const conn = await loadConnection(db, p.connection_id)
  const row = await db.one<{ id: string }>(
    `insert into executions (org_id, connection_id, proposal_id, approval_id, idempotency_key, status, is_synthetic, agent_id, policy_id, policy_version) values ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9)
     on conflict (idempotency_key) do nothing returning id`,
    [p.org_id, p.connection_id, p.id, approvalId, String(approvalId), conn?.is_synthetic ?? false, p.agent_id ?? null, p.policy_id ?? null, p.policy_version ?? null])
  return row?.id ?? (await db.one<{ id: string }>('select id from executions where idempotency_key = $1', [String(approvalId)]))!.id
}

/** Retry a failed or unconfirmed execution: same approval, same row, fresh recheck. */
export async function retryExecution(actor: Actor, executionId: string, opts: { now?: Date; ip?: string | null } = {}): Promise<ExecutionResult> {
  const visible = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from executions where id = $1', [executionId]), { ip: opts.ip })
  if (!visible) throw new EngineError('not_found', 'execution not found')
  assertMerchant(actor, visible.org_id)
  const claimed = await admin(async db => {
    const r = await db.one<ExecRow>(
      `update executions set status = 'prechecking', attempt = attempt + 1, status_reason = null where id = $1 and status in ('failed','unknown','verification_failed') returning *`, [executionId])
    if (!r) return null
    const approval = await db.one('select 1 from approvals where id = $1 and revoked_at is null', [r.approval_id])
    if (!approval) {
      await db.query(`update executions set status = 'blocked', status_reason = 'approval revoked', finished_at = now() where id = $1`, [r.id])
      return null
    }
    await db.query(`update proposals set status = 'executing' where id = $1 and status in ('failed','applied')`, [r.proposal_id])
    await audit(db, { orgId: r.org_id, connectionId: r.connection_id, entityType: 'execution', entityId: r.id, event: 'execution.retry', actor: actor.label, detail: { attempt: r.attempt } })
    return r
  })
  if (!claimed) throw new EngineError('not_retryable', 'only failed or unconfirmed executions with a valid approval can be retried')
  return runExecution(executionId, { actor: actor.label, now: opts.now })
}

async function finish(execId: string, p: ProposalRow, status: ExecutionStatus, proposalStatus: string, reason: string | null, extra: Record<string, unknown>, actor: string) {
  await admin(async db => {
    const sets = ['status = $2', 'status_reason = $3', 'finished_at = now()']
    const vals: unknown[] = [execId, status, reason]
    for (const [k, v] of Object.entries(extra)) { vals.push(k === 'precheck' || k === 'request' || k === 'response' || k === 'verification' || k === 'qualification' ? JSON.stringify(v) : v); sets.push(`${k} = $${vals.length}`) }
    await db.query(`update executions set ${sets.join(', ')} where id = $1`, vals)
    await db.query(`update proposals set status = $2, status_reason = $3 where id = $1`, [p.id, proposalStatus, reason])
    if (proposalStatus === 'stale' || proposalStatus === 'blocked') {
      await db.query(`update approvals set revoked_at = now(), revoke_reason = $2 where proposal_id = $1 and revoked_at is null`, [p.id, `execution ${status}: ${reason}`])
    }
    if (status === 'verified') {
      await db.query(`update issues set status = 'resolved', resolved_at = now(), resolution = 'verified_fix', status_reason = 'changed by Deploi and confirmed by a fresh read' where id = $1 and status in ('open','needs_review')`, [p.issue_id])
    }
    if (status === 'stale' && reason === 'already in the proposed state') {
      await db.query(`update issues set status = 'resolved', resolved_at = now(), resolution = 'no_longer_detected', status_reason = 'already corrected outside Deploi' where id = $1 and status in ('open','needs_review')`, [p.issue_id])
    }
    await audit(db, { orgId: p.org_id, connectionId: p.connection_id, entityType: 'execution', entityId: execId, event: `execution.${status}`, actor, detail: { reason, proposal_id: p.id } })
  })
}

/** Fresh read of a target: a variant by id, or a product-level target via any of its variants. */
async function readOne(conn: ConnectionRow, id: string): Promise<ResourceRecord | null> {
  const m = await getConnector(conn.platform).readResources(conn, [id])
  return m.get(id) ?? [...m.values()].find(r => r.productId === id) ?? null
}

async function runExecution(execId: string, opts: { actor: string; now?: Date }): Promise<ExecutionResult> {
  const ctx = await admin(async db => {
    const exec = await db.one<ExecRow>('select * from executions where id = $1', [execId])
    const p = await db.one<ProposalRow>('select * from proposals where id = $1', [exec!.proposal_id])
    const conn = await loadConnection(db, exec!.connection_id)
    const issue = await db.one<{ check_key: string }>('select check_key from issues where id = $1', [p!.issue_id])
    const approval = await db.one<{ id: string; approver_kind: string; policy_id: string | null; policy_version: number | null }>('select id, approver_kind, policy_id, policy_version from approvals where id = $1', [exec!.approval_id])
    const agentCtx = p!.agent_id ? await loadAgentContext(db, p!.agent_id) : null
    const agentRow = p!.agent_id ? await db.one<{ status: string }>('select status from agents where id = $1', [p!.agent_id]) : null
    const plan = p!.agent_id ? agentCtx?.plan ?? null : await legacyPlan(db, conn!)
    const sub = await db.one<{ id: string }>(`select id from app_subscriptions where org_id = $1 and status = 'active' limit 1`, [p!.org_id])
    const day = p!.agent_id ? await db.one<{ n: string }>(
      `select count(*)::text as n from executions e join approvals a on a.id = e.approval_id where e.agent_id = $1 and a.approver_kind = 'standing_authorization'
       and e.started_at >= date_trunc('day', now()) and e.status not in ('blocked','stale') and e.id <> $2`, [p!.agent_id, execId]) : null
    await db.query('update executions set agent_id = $2, policy_id = $3, policy_version = $4 where id = $1', [execId, p!.agent_id ?? null, p!.policy_id ?? null, p!.policy_version ?? null])
    return { exec: exec!, p: p!, conn: conn!, checkKey: issue!.check_key, approval: approval!, agentCtx, agentStatus: agentRow?.status ?? null, plan, hasSubscription: Boolean(sub), dayCount: Number(day?.n ?? 0) }
  })
  const { p, conn, agentCtx, plan } = ctx
  const correction = correctionFromProposal(p)
  const connector = getConnector(conn.platform)
  const standing = ctx.approval.approver_kind === 'standing_authorization'

  // ---- gates: anything here blocks without touching the store
  const required = connector.requiredScopes.actions[p.action_key] ?? []
  const missing = required.filter(s => !conn.scopes.includes(s))
  // unknown action keys have no registered field and are always refused
  const field = actionField(p.action_key) ?? ''
  const agentBlock = !p.agent_id ? null
    : ctx.agentStatus !== 'active' ? `the agent is ${ctx.agentStatus ?? 'deleted'}; it may not write`
    : !agentCtx ? 'the agent has no active authorization'
    : (p.policy_version ?? null) !== agentCtx.policyRow.version ? null // handled as stale below (recompute)
    : !writableFields(agentCtx.policy).includes(field) ? `field "${field}" is not writable for this agent`
    : standing && (ctx.approval.policy_id !== agentCtx.policyRow.id || ctx.approval.policy_version !== agentCtx.policyRow.version) ? 'the standing authorization that covered this change was changed or revoked'
    : null
  const block =
    !field ? `no connector declares the action ${p.action_key}`
    : conn.status !== 'active' ? `store connection is ${conn.status}`
    : !connector.operational ? `${conn.platform} connector is not operational`
    : missing.length ? `missing permission: ${missing.join(', ')}`
    : engineConfig.billingRequired && !ctx.hasSubscription ? 'no active subscription'
    : !liveWritesAllowed(conn.external_id, conn.is_synthetic) ? 'writes to this live store are disabled in this environment'
    : agentBlock
  if (block) { await finish(execId, p, 'blocked', 'blocked', block, {}, opts.actor); return { executionId: execId, status: 'blocked', reason: block } }
  if (p.agent_id && agentCtx && (p.policy_version ?? null) !== agentCtx.policyRow.version) {
    const reason = "the agent's authorization changed since this proposal; it will be recomputed on the next run"
    await finish(execId, p, 'stale', 'stale', reason, {}, opts.actor)
    return { executionId: execId, status: 'stale', reason }
  }

  // ---- recheck: fresh read, scope, preconditions, and the check must still produce the same approved change
  let fresh: ResourceRecord | null
  try {
    fresh = await readOne(conn, p.target_id)
  } catch (e) {
    const reason = `could not read the record before writing: ${(e as Error).message.slice(0, 160)}`
    await finish(execId, p, 'failed', 'failed', reason, { precheck: { error: reason } }, opts.actor)
    return { executionId: execId, status: 'failed', reason }
  }
  if (!fresh) { await finish(execId, p, 'stale', 'stale', 'the record no longer exists', { precheck: { found: false } }, opts.actor); return { executionId: execId, status: 'stale', reason: 'the record no longer exists' } }
  const current = getPath(fresh, correction.change.field)
  const failed = correction.preconditions.filter(c => !sameValue(getPath(fresh, c.path), c.equals)).map(c => ({ path: c.path, expected: c.equals, actual: getPath(fresh, c.path), description: c.description }))
  const precheck: Record<string, unknown> = { fetchedAt: fresh.fetchedAt, field: correction.change.field, current, failed }
  if (plan?.scope && !plan.scope(fresh)) {
    const reason = "the product is now outside the agent's scope or is an exception"
    await finish(execId, p, 'blocked', 'blocked', reason, { precheck, before_value: JSON.stringify(current ?? null) }, opts.actor)
    return { executionId: execId, status: 'blocked', reason }
  }
  if (sameValue(current, correction.change.to)) {
    await finish(execId, p, 'stale', 'stale', 'already in the proposed state', { precheck }, opts.actor)
    return { executionId: execId, status: 'stale', reason: 'already in the proposed state' }
  }
  const pc = plan?.checks.find(c => c.check.key === ctx.checkKey) ?? null
  let rehash: string | null = null
  if (pc) {
    let store = buildStoreContext([fresh], plan!.currency, false)
    const keys = lookupKeysFor([fresh], plan!, store)
    if (connector.findResources && (keys.skus.length || keys.barcodes.length || keys.handles.length)) {
      const extra = await connector.findResources(conn, keys).catch(() => [] as ResourceRecord[])
      store = buildStoreContext([fresh, ...extra.filter(r => r.resourceId !== fresh!.resourceId)], plan!.currency, false)
    }
    const found = detectWithPlan(fresh, { ...plan!, scope: null, checks: [pc] }, store)
      .find(f => f.correction && f.correction.actionKey === p.action_key && f.correction.targetId === p.target_id)
    rehash = found?.correction ? changeHash(conn.id, withOwner(found.correction, p.agent_id ?? null), pc.version) : null
  }
  if (failed.length || rehash !== p.change_hash) {
    const reason = failed.length ? 'records changed since approval' : !pc ? 'the rule or authorization no longer covers this check' : 'the check no longer proposes this exact change (records or reference data changed)'
    await finish(execId, p, 'stale', 'stale', reason, { precheck: { ...precheck, rehash } }, opts.actor)
    return { executionId: execId, status: 'stale', reason }
  }
  // standing authorization: re-qualify on the fresh record at the moment of writing
  let qualification: Qualification | null = null
  if (standing && agentCtx) {
    qualification = qualifies(agentCtx, { actionKey: p.action_key, change: correction.change as never, record: fresh, counts: { run: null, day: ctx.dayCount } })
    if (!qualification.covered) {
      const reason = `not covered by the standing authorization: ${qualification.blockers.join('; ')}`
      await admin(async db => {
        await db.query(`update executions set status = 'blocked', status_reason = $2, qualification = $3, precheck = $4, finished_at = now() where id = $1`, [execId, reason, JSON.stringify(qualification), JSON.stringify(precheck)])
        await db.query(`update approvals set revoked_at = now(), revoke_reason = $2 where id = $1`, [ctx.approval.id, reason])
        await db.query(`update proposals set status = 'pending_approval', status_reason = $2 where id = $1`, [p.id, 'waiting for your approval: ' + qualification!.blockers.join('; ')])
        await audit(db, { orgId: p.org_id, connectionId: p.connection_id, entityType: 'execution', entityId: execId, event: 'execution.routed_for_approval', actor: opts.actor, detail: { blockers: qualification!.blockers } })
      })
      return { executionId: execId, status: 'blocked', reason }
    }
  }
  const allowedFields = agentCtx ? writableFields(agentCtx.policy) : [field]

  // ---- write
  await admin(async db => {
    await db.query(`update executions set status = 'executing', precheck = $2, before_value = $3, qualification = $4 where id = $1`, [execId, JSON.stringify(precheck), JSON.stringify(current ?? null), qualification ? JSON.stringify(qualification) : null])
  })
  let result: ApplyResult
  try {
    result = await connector.applyAction(conn, correction, allowedFields)
  } catch (e) {
    result = { outcome: 'unknown', request: { actionKey: correction.actionKey, targetId: correction.targetId }, response: null, error: (e as Error).message.slice(0, 300) }
  }
  if (result.outcome === 'rejected' && result.blocked) {
    await finish(execId, p, 'blocked', 'blocked', result.error ?? 'the connector refused the change before writing', { request: result.request, response: result.response }, opts.actor)
    return { executionId: execId, status: 'blocked', reason: result.error }
  }
  if (result.outcome === 'rejected') {
    await finish(execId, p, 'failed', 'failed', result.error ?? 'the platform refused the change', { request: result.request, response: result.response }, opts.actor)
    return { executionId: execId, status: 'failed', reason: result.error }
  }
  await admin(async db => {
    await db.query(`update executions set status = $2, applied_at = case when $2 = 'applied' then now() else applied_at end, request = $3, response = $4, status_reason = $5 where id = $1`,
      [execId, result.outcome, JSON.stringify(result.request), JSON.stringify(result.response), result.error ?? null])
    await db.query(`update proposals set status = 'applied' where id = $1`, [p.id])
    await audit(db, { orgId: p.org_id, connectionId: p.connection_id, entityType: 'execution', entityId: execId, event: `execution.${result.outcome}`, actor: opts.actor, detail: { error: result.error ?? null } })
  })

  // ---- verify with fresh reads
  let observed: unknown = undefined
  let lastRead: ResourceRecord | null = null
  for (let i = 0; i < engineConfig.verifyAttempts; i++) {
    if (i > 0) await sleep(engineConfig.verifyDelayMs * i)
    try { lastRead = await readOne(conn, p.target_id) } catch { lastRead = null }
    observed = lastRead ? getPath(lastRead, correction.change.field) : undefined
    if (sameValue(observed, correction.change.to)) break
  }
  const verification = { field: correction.change.field, expected: correction.change.to, observed, readAt: lastRead?.fetchedAt ?? null, attempts: engineConfig.verifyAttempts }
  if (sameValue(observed, correction.change.to)) {
    await finish(execId, p, 'verified', 'verified', null, { verification, verified_at: new Date().toISOString(), after_value: JSON.stringify(observed ?? null) }, opts.actor)
    return { executionId: execId, status: 'verified' }
  }
  if (result.outcome === 'unknown' && sameValue(observed, correction.change.from)) {
    await finish(execId, p, 'failed', 'failed', 'not applied: the platform gave no definite answer and a fresh read shows no change', { verification, after_value: JSON.stringify(observed ?? null) }, opts.actor)
    return { executionId: execId, status: 'failed', reason: 'not applied' }
  }
  await finish(execId, p, 'verification_failed', 'failed', 'a fresh read does not show the change', { verification, after_value: JSON.stringify(observed ?? null) }, opts.actor)
  return { executionId: execId, status: 'verification_failed' }
}

/** Approve-then-run helper used by the API: approval and execution are separate records and steps. */
export async function approveAndExecute(actor: Actor, proposalId: string, shownHash: string, opts: { ip?: string | null } = {}) {
  const { approveProposal } = await import('./approve')
  const a = await approveProposal(actor, proposalId, shownHash, opts)
  const r = await executeProposal(proposalId, { actor: actor.label })
  return { approvalId: a.approvalId, ...r }
}
