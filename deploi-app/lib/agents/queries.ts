/** Agent reads for the merchant UI. Every query runs as the actor, so RLS limits it to their organization. */
import { withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { expansionReasons, parsePolicy } from './policy'

const orgFilter = (actor: Actor, col = 'org_id') => (actor.kind === 'staff' ? 'true' : `${col} = current_org_id()`)

export type AgentListItem = {
  id: string; name: string; status: string; task_text: string; connection_id: string; store: string | null
  schedule: unknown; next_run_at: string | null; last_run_at: string | null
  active_version: number | null; approval_mode: string | null; email_permission: string | null; correction_types: string[]; summary: unknown
  pending_version: number | null; awaiting_approval: number; needs_person: number
  last_run: { status: string; counts: Record<string, unknown>; finished_at: string | null; status_reason: string | null } | null
}

export async function listAgents(actor: Actor, connectionId?: string | null): Promise<AgentListItem[]> {
  return withActor(actor, db => db.query<AgentListItem>(
    `select a.id, a.name, a.status, a.task_text, a.connection_id, coalesce(c.display_name, c.external_id) as store, a.schedule, a.next_run_at, a.last_run_at,
       ap.version as active_version, ap.policy->>'approvalMode' as approval_mode, ap.policy->'email'->>'permission' as email_permission,
       coalesce((select array_agg(x) from jsonb_array_elements_text(ap.policy->'correctionTypes') x), '{}') as correction_types, ap.summary,
       (select max(version) from agent_policies pp where pp.agent_id = a.id and pp.status = 'pending_grant') as pending_version,
       (select count(*)::int from proposals p where p.agent_id = a.id and p.status = 'pending_approval' and coalesce(p.status_reason, '') not like 'draft:%') as awaiting_approval,
       (select count(*)::int from issues i where i.agent_id = a.id and i.kind = 'needs_person' and i.status in ('open','needs_review')) as needs_person,
       (select json_build_object('status', r.status, 'counts', r.counts, 'finished_at', r.finished_at, 'status_reason', r.status_reason) from agent_runs r where r.agent_id = a.id order by r.started_at desc limit 1) as last_run
     from agents a join store_connections c on c.id = a.connection_id
     left join agent_policies ap on ap.id = a.active_policy_id
     where ${orgFilter(actor, 'a.org_id')} and a.status <> 'deleted' and ($1::uuid is null or a.connection_id = $1)
     order by a.created_at`, [connectionId ?? null]))
}

export async function agentDetail(actor: Actor, agentId: string) {
  return withActor(actor, async db => {
    const agent = await db.one<{ id: string; org_id: string; name: string; status: string; task_text: string; connection_id: string; active_policy_id: string | null; schedule: unknown; next_run_at: string | null; last_run_at: string | null; created_at: string; created_by: string }>(
      `select id, org_id, name, status, task_text, connection_id, active_policy_id, schedule, next_run_at, last_run_at, created_at, created_by from agents where id = $1 and status <> 'deleted' and ${orgFilter(actor)}`, [agentId])
    if (!agent) throw new EngineError('not_found', 'agent not found')
    const policies = await db.query(`select id, version, policy, policy_hash, summary, status, requires_grant, created_by, created_at, granted_by, granted_at, revoked_at, revoke_reason from agent_policies where agent_id = $1 order by version desc limit 20`, [agentId])
    const runs = await db.query(`select id, policy_version, trigger, status, status_reason, counts, started_at, finished_at from agent_runs where agent_id = $1 order by started_at desc limit 20`, [agentId])
    const executions = await db.query(
      `select e.id, e.status, e.status_reason, e.started_at, e.finished_at, e.verified_at, e.attempt, e.before_value, e.after_value, e.qualification, e.policy_version,
         p.action_key, p.target_label, p.change, a.approver_kind, a.approved_by
       from executions e join proposals p on p.id = e.proposal_id join approvals a on a.id = e.approval_id
       where e.agent_id = $1 order by e.started_at desc limit 50`, [agentId])
    const waiting = await db.query(
      `select p.id, p.action_key, p.target_label, p.change, p.change_hash, p.status, p.status_reason, p.expires_at, i.id as issue_id, i.evidence->>'summary' as summary, i.severity, i.evidence
       from proposals p join issues i on i.id = p.issue_id where p.agent_id = $1 and p.status = 'pending_approval' order by i.severity = 'high' desc, p.created_at limit 100`, [agentId])
    const needsPerson = await db.query(
      `select id, check_key, resource_label, severity, evidence->>'summary' as summary, evidence->>'humanAction' as human_action, evidence, first_detected_at from issues where agent_id = $1 and kind = 'needs_person' and status in ('open','needs_review') order by severity = 'high' desc, first_detected_at limit 100`, [agentId])
    // what a version waiting for a grant would add to the active one (read-only; shown next to its Grant button)
    const active = (policies as { status: string; policy: unknown }[]).find(p => p.status === 'active')
    const pending = (policies as { status: string; policy: unknown }[]).find(p => p.status === 'pending_grant')
    let pendingExpansion: string[] | null = null
    if (pending) {
      try { pendingExpansion = active ? expansionReasons(parsePolicy(active.policy), parsePolicy(pending.policy)) : ['first authorization'] } catch { pendingExpansion = null }
    }
    return { agent, policies, runs, executions, waiting, needsPerson, pendingExpansion }
  })
}

export async function listReferences(actor: Actor, connectionId?: string | null) {
  return withActor(actor, db => db.query(
    `select id, connection_id, kind, name, version, status, row_count, error_count, ambiguous_keys, row_errors, columns, uploaded_by, created_at, updated_at
     from reference_sources where ${orgFilter(actor)} and status = 'active' and ($1::uuid is null or connection_id = $1) order by kind, name`, [connectionId ?? null]))
}
