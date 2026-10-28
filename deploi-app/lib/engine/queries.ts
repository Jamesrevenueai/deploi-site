/**
 * Read side for the merchant API and UI. Every query runs as the actor with RLS enforced, so an
 * organization only ever sees its own connections, issues, proposals, executions and audit trail.
 */
import { withActor, type Actor } from './actor'
import { getCheck } from './registry'
import { executionOutcome, proposalOutcome, type Outcome } from './outcomes'

export type ConnectionView = { id: string; platform: string; external_id: string; display_name: string | null; status: string; scopes: string[]; api_version: string | null; timezone: string | null; is_synthetic: boolean; installed_at: string | null; last_scan_at: string | null }
export type IssueView = {
  id: string; connection_id: string; platform: string; check_key: string; check_title: string; kind: 'correctable' | 'needs_person'
  resource_type: string; resource_id: string; resource_label: string | null; severity: 'high' | 'medium' | 'low'
  status: string; status_reason: string | null; evidence: Record<string, unknown>; rule_version: number | null
  first_detected_at: string; last_seen_at: string; resolved_at: string | null; resolution: string | null
  proposal: ProposalView | null
}
export type ProposalView = {
  id: string; issue_id: string; action_key: string; target_id: string; target_label: string | null
  change: { field: string; from: unknown; to: unknown; params?: Record<string, unknown> }
  preconditions: { path: string; equals: unknown; description: string }[]
  rule_version: number | null; change_hash: string; status: string; status_reason: string | null; outcome: Outcome
  expires_at: string; created_at: string; decided_at: string | null
}
export type ExecutionView = {
  id: string; proposal_id: string; status: string; status_reason: string | null; outcome: Outcome; attempt: number
  precheck: Record<string, unknown> | null; verification: Record<string, unknown> | null; response: Record<string, unknown> | null
  is_synthetic: boolean; started_at: string; applied_at: string | null; verified_at: string | null; finished_at: string | null
  target_label: string | null; change: ProposalView['change']; approved_by: string | null; approved_at: string | null
}
export type AuditView = { id: number; entity_type: string; entity_id: string | null; event: string; actor: string; detail: Record<string, unknown>; at: string }

const PROPOSAL_COLS = 'id, issue_id, action_key, target_id, target_label, change, preconditions, rule_version, change_hash, status, status_reason, expires_at, created_at, decided_at'

function toProposal(r: Omit<ProposalView, 'outcome'>): ProposalView { return { ...r, outcome: proposalOutcome(r.status) } }

export async function listConnections(actor: Actor): Promise<ConnectionView[]> {
  return withActor(actor, db => db.query<ConnectionView>(
    `select id, platform, external_id, display_name, status, scopes, api_version, timezone, is_synthetic, installed_at, last_scan_at from store_connections ${actor.kind === 'staff' ? '' : 'where org_id = current_org_id()'} order by created_at`))
}

export async function overview(actor: Actor) {
  return withActor(actor, async db => {
    const scope = actor.kind === 'staff' ? 'true' : 'org_id = current_org_id()'
    const issues = await db.query<{ status: string; kind: string; severity: string; n: string }>(`select status, kind, severity, count(*)::text as n from issues where ${scope} and status in ('open','needs_review') group by 1,2,3`)
    const proposals = await db.query<{ status: string; n: string }>(`select status, count(*)::text as n from proposals where ${scope} group by 1`)
    const execs = await db.query<{ status: string; n: string }>(`select status, count(*)::text as n from executions where ${scope} and started_at > now() - interval '30 days' group by 1`)
    const lastScan = await db.one<{ id: string; status: string; started_at: string; finished_at: string | null; resources_scanned: number; issues_opened: number; issues_resolved: number; error: string | null }>(
      `select id, status, started_at, finished_at, resources_scanned, issues_opened, issues_resolved, error from scans where ${scope} order by started_at desc limit 1`)
    const sub = await db.one<{ provider: string; plan_key: string; status: string; is_test: boolean; current_period_end: string | null }>(
      `select provider, plan_key, status, is_test, current_period_end from app_subscriptions where ${scope} order by created_at desc limit 1`)
    const outcomeCounts: Record<Outcome, number> = { pending: 0, verified: 0, failed: 0, blocked: 0, closed: 0 }
    for (const e of execs) outcomeCounts[executionOutcome(e.status)] += Number(e.n)
    const n = (rows: { n: string }[]) => rows.reduce((s, r) => s + Number(r.n), 0)
    return {
      openIssues: n(issues.filter(i => i.status === 'open')),
      needsReview: n(issues.filter(i => i.status === 'needs_review')),
      needsPerson: n(issues.filter(i => i.kind === 'needs_person')),
      highSeverity: n(issues.filter(i => i.severity === 'high')),
      waitingApproval: Number(proposals.find(p => p.status === 'pending_approval')?.n ?? 0),
      executions30d: outcomeCounts,
      lastScan, subscription: sub,
    }
  })
}

export async function listIssues(actor: Actor, filter: { status?: 'live' | 'resolved' | 'all'; kind?: string; connectionId?: string } = {}): Promise<IssueView[]> {
  return withActor(actor, async db => {
    const where: string[] = [actor.kind === 'staff' ? 'true' : 'i.org_id = current_org_id()']
    const params: unknown[] = []
    const status = filter.status ?? 'live'
    if (status === 'live') where.push(`i.status in ('open','needs_review')`)
    if (status === 'resolved') where.push(`i.status in ('resolved','dismissed')`)
    if (filter.kind) { params.push(filter.kind); where.push(`i.kind = $${params.length}`) }
    if (filter.connectionId) { params.push(filter.connectionId); where.push(`i.connection_id = $${params.length}`) }
    const rows = await db.query<Omit<IssueView, 'check_title' | 'proposal'>>(
      `select i.id, i.connection_id, i.platform, i.check_key, i.kind, i.resource_type, i.resource_id, i.resource_label, i.severity, i.status, i.status_reason, i.evidence, i.rule_version,
              i.first_detected_at, i.last_seen_at, i.resolved_at, i.resolution
       from issues i where ${where.join(' and ')}
       order by case i.severity when 'high' then 0 when 'medium' then 1 else 2 end, i.last_seen_at desc limit 500`, params)
    const props = rows.length ? await db.query<Omit<ProposalView, 'outcome'>>(
      `select distinct on (issue_id) ${PROPOSAL_COLS} from proposals where issue_id = any($1::uuid[]) order by issue_id, created_at desc`, [rows.map(r => r.id)]) : []
    const byIssue = new Map(props.map(p => [p.issue_id, toProposal(p)]))
    return rows.map(r => ({ ...r, check_title: getCheck(r.check_key)?.title ?? r.check_key, proposal: byIssue.get(r.id) ?? null }))
  })
}

export async function issueDetail(actor: Actor, issueId: string) {
  return withActor(actor, async db => {
    const i = await db.one<Omit<IssueView, 'check_title' | 'proposal'>>(
      `select id, connection_id, platform, check_key, kind, resource_type, resource_id, resource_label, severity, status, status_reason, evidence, rule_version,
              first_detected_at, last_seen_at, resolved_at, resolution from issues where id = $1`, [issueId])
    if (!i) return null
    const proposals = (await db.query<Omit<ProposalView, 'outcome'>>(`select ${PROPOSAL_COLS} from proposals where issue_id = $1 order by created_at desc`, [i.id])).map(toProposal)
    const executions = await listExecutionsFor(db, proposals.map(p => p.id))
    const ids = [i.id, ...proposals.map(p => p.id), ...executions.map(e => e.id)]
    const trail = await db.query<AuditView>(`select id, entity_type, entity_id, event, actor, detail, at from engine_audit where entity_id = any($1::text[]) order by at, id`, [ids])
    const check = getCheck(i.check_key)
    const rule = await db.one<{ enabled: boolean; config: Record<string, unknown>; version: number }>('select enabled, config, version from merchant_rules where connection_id = $1 and check_key = $2', [i.connection_id, i.check_key])
    return {
      issue: { ...i, check_title: check?.title ?? i.check_key, proposal: proposals[0] ?? null },
      check: check ? { key: check.key, title: check.title, description: check.description, whyItIsAnError: check.whyItIsAnError } : null,
      rule, proposals, executions, trail,
    }
  })
}

async function listExecutionsFor(db: import('../db').Db, proposalIds: string[]): Promise<ExecutionView[]> {
  if (!proposalIds.length) return []
  const rows = await db.query<Omit<ExecutionView, 'outcome'>>(
    `select e.id, e.proposal_id, e.status, e.status_reason, e.attempt, e.precheck, e.verification, e.response, e.is_synthetic, e.started_at, e.applied_at, e.verified_at, e.finished_at,
            p.target_label, p.change, a.approved_by, a.approved_at
     from executions e join proposals p on p.id = e.proposal_id left join approvals a on a.id = e.approval_id
     where e.proposal_id = any($1::uuid[]) order by e.started_at desc`, [proposalIds])
  return rows.map(r => ({ ...r, outcome: executionOutcome(r.status) }))
}

export async function activity(actor: Actor, opts: { outcome?: Outcome; limit?: number } = {}) {
  return withActor(actor, async db => {
    const scope = actor.kind === 'staff' ? 'true' : 'e.org_id = current_org_id()'
    const rows = await db.query<Omit<ExecutionView, 'outcome'>>(
      `select e.id, e.proposal_id, e.status, e.status_reason, e.attempt, e.precheck, e.verification, e.response, e.is_synthetic, e.started_at, e.applied_at, e.verified_at, e.finished_at,
              p.target_label, p.change, a.approved_by, a.approved_at
       from executions e join proposals p on p.id = e.proposal_id left join approvals a on a.id = e.approval_id
       where ${scope} order by e.started_at desc limit $1`, [Math.min(opts.limit ?? 100, 500)])
    const list = rows.map(r => ({ ...r, outcome: executionOutcome(r.status) }))
    const blockedProposals = await db.query<Omit<ProposalView, 'outcome'>>(
      `select ${PROPOSAL_COLS} from proposals p where ${scope.replace('e.', 'p.')} and status in ('stale','expired','blocked') order by updated_at desc limit 50`)
    return { executions: opts.outcome ? list.filter(e => e.outcome === opts.outcome) : list, blockedProposals: blockedProposals.map(toProposal) }
  })
}

export async function auditTrail(actor: Actor, limit = 200): Promise<AuditView[]> {
  return withActor(actor, db => db.query<AuditView>(
    `select id, entity_type, entity_id, event, actor, detail, at from engine_audit ${actor.kind === 'staff' ? '' : 'where org_id = current_org_id()'} order by at desc, id desc limit $1`, [Math.min(limit, 1000)]))
}

export async function listRules(actor: Actor, connectionId: string) {
  return withActor(actor, async db => {
    const rows = await db.query<{ id: string; check_key: string; enabled: boolean; config: Record<string, unknown>; version: number; updated_by: string | null; updated_at: string }>(
      'select id, check_key, enabled, config, version, updated_by, updated_at from merchant_rules where connection_id = $1 order by check_key', [connectionId])
    return rows.map(r => {
      const c = getCheck(r.check_key)
      return { ...r, title: c?.title ?? r.check_key, description: c?.description ?? '', whyItIsAnError: c?.whyItIsAnError ?? '', kind: c?.kind ?? 'needs_person' }
    })
  })
}
