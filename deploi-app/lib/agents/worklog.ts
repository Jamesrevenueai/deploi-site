/**
 * An agent's work log, in the merchant's words: every recorded action with what happened, when, why,
 * and which permission allowed it (the authorization version and tier, the merchant's own approval, or
 * "nothing: refused"). Built from the append-only engine audit trail, read under the merchant's RLS.
 */
import { withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { TIER_LABEL, tierOfMode, type ApprovalMode, type Tier } from './policy'

export type WorkLogEntry = { at: string; what: string; why: string | null; permission: string; event: string; actor: string; ref: { type: string; id: string | null } }

type AuditRow = { id: string; entity_type: string; entity_id: string | null; event: string; actor: string; detail: Record<string, unknown>; at: string }

/** Field names in words for the log (the store UI uses the same wording). */
const FIELD_WORDS: Record<string, string> = { inventoryPolicy: 'continue selling when out of stock', price: 'price', compareAtPrice: 'compare-at price', sku: 'SKU', published: 'published on the sales channel' }

const WHAT: Record<string, string> = {
  'agent.created': 'Agent created (nothing granted yet)', 'agent.paused': 'Paused: no runs and no writes', 'agent.resumed': 'Resumed',
  'agent.revoked': 'Authorization revoked: nothing more is written or sent', 'agent.deleted': 'Deleted: authorization revoked, history kept',
  'policy.awaiting_grant': 'New rules prepared, waiting for your grant', 'policy.applied_without_grant': 'Narrower rules applied (no grant needed)', 'policy.granted': 'Rules granted',
  'agent_run.started': 'Run started', 'agent_run.completed': 'Run finished', 'agent_run.failed': 'Run failed', 'agent_run.blocked': 'Run blocked',
  'approval.standing': 'Change approved under the standing authorization', 'approval.granted': 'You approved a change', 'approval.refused': 'Approval refused',
  'execution.started': 'Change started', 'execution.applied': 'Change written, confirming with a fresh read', 'execution.verified': 'Change made and confirmed by a fresh read', 'execution.failed': 'Change failed',
  'execution.verification_failed': 'Change did not stick (failed verification)', 'execution.blocked': 'Change blocked before anything was written', 'execution.stale': 'Change skipped: the record changed first',
  'execution.unknown': 'Change outcome unknown', 'execution.retry': 'Change retried',
  'email.draft': 'Email drafted (not sent)', 'email.awaiting_approval': 'Email waiting for your approval', 'email.queued': 'Email queued to send', 'email.sending': 'Email sending',
  'email.accepted': 'Email accepted by the provider (not proof of delivery)', 'email.failed': 'Email failed: nothing was sent', 'email.delivery_unknown': 'Email outcome unknown: not resent automatically',
  'email.cancelled': 'Email cancelled: not sent', 'email.approved': 'You approved an email', 'email.edited': 'Email edited (approval cleared)', 'email.declined': 'You declined an email',
  'email.reply_seen': 'Reply noticed (content not acted on)', 'email.inbound.accepted': 'Email received from an allowed sender', 'email.inbound.quarantined': 'Email received and quarantined',
  'scan.completed': 'Store read and checked', 'scan.failed': 'Store could not be read', 'proposal.created': 'Exact change recorded',
  'proposal.expired': 'Recorded change expired', 'proposal.stale': 'Recorded change went stale (the record changed)', 'proposal.blocked': 'Recorded change blocked',
  'issue.detected': 'Problem found', 'issue.resolved': 'Problem resolved', 'issue.dismissed': 'Problem dismissed by you', 'issue.exempted': 'Problem exempted',
  'issue.loop_guard': 'Stopped repeating the same change (loop guard)', 'issue.conflicting_agent': 'Skipped: another agent covers this record', 'execution.routed_for_approval': 'Change sent for your approval',
  'mailbox.created': 'Agent mailbox created', 'mailbox.closed': 'Agent mailbox closed',
  'task.queued': 'Task accepted: within the rules', 'task.needs_approval': 'Task outside the rules: needs your approval', 'task.refused': 'Task refused: nothing will run',
  'task.running': 'Task running', 'task.done': 'Task done (with proof)', 'task.waiting_on_you': 'Task run finished: waiting on you', 'task.failed': 'Task failed', 'task.cancelled': 'Task cancelled',
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)

export async function agentWorkLog(actor: Actor, agentId: string, opts: { limit?: number } = {}): Promise<WorkLogEntry[]> {
  return withActor(actor, async db => {
    const agent = await db.one<{ id: string }>('select id from agents where id = $1', [agentId])
    if (!agent) throw new EngineError('not_found', 'agent not found')
    const policies = await db.query<{ id: string; version: number; mode: ApprovalMode; email_permission: Tier | null; valid_until: string | null }>(
      `select id, version, coalesce(policy->>'approvalMode', 'review') as mode, policy->'email'->>'permission' as email_permission, policy->>'validUntil' as valid_until from agent_policies where agent_id = $1`, [agentId])
    const byVersion = new Map(policies.map(p => [p.version, p]))
    const execs = await db.query<{ id: string; policy_version: number | null; approver_kind: string | null; approved_by: string | null; target_label: string | null; field: string | null }>(
      `select e.id, e.policy_version, a.approver_kind, a.approved_by, p.target_label, p.change->>'field' as field from executions e left join approvals a on a.id = e.approval_id left join proposals p on p.id = e.proposal_id where e.agent_id = $1`, [agentId])
    const execMap = new Map(execs.map(e => [e.id, e]))
    const mails = await db.query<{ id: string; policy_version: number | null; approval_kind: string | null; approved_by: string | null; task_key: string; to_addresses: string[] }>(
      'select id, policy_version, approval_kind, approved_by, task_key, to_addresses from email_messages where agent_id = $1', [agentId])
    const mailMap = new Map(mails.map(m => [m.id, m]))
    const inbound = await db.query<{ id: string }>('select id from email_inbound where agent_id = $1', [agentId])
    const props = await db.query<{ id: string; approval_id: string | null; policy_version: number | null }>('select p.id, a.id as approval_id, p.policy_version from proposals p left join approvals a on a.proposal_id = p.id where p.agent_id = $1', [agentId])
    const propVersion = new Map(props.map(p => [p.id, p.policy_version]))
    const ids = [...execs.map(e => e.id), ...mails.map(m => m.id), ...inbound.map(i => i.id), ...props.map(p => p.id), ...props.map(p => p.approval_id).filter((x): x is string => Boolean(x))]
    const rows = await db.query<AuditRow>(
      `select id::text, entity_type, entity_id, event, actor, detail, at from engine_audit
       where (entity_type = 'agent' and entity_id = $1) or detail->>'agent_id' = $1 or entity_id = any($2::text[])
       order by at desc, id desc limit $3`, [agentId, ids, Math.min(opts.limit ?? 200, 500)])

    const versionWords = (v: number | null | undefined, tool: 'store' | 'email' = 'store') => {
      if (!v) return null
      const p = byVersion.get(v)
      if (!p) return `authorization v${v}`
      const tier: Tier | null = tool === 'store' ? tierOfMode(p.mode) : p.email_permission
      return `authorization v${v}${tier ? ` (${tool}: ${TIER_LABEL[tier]}${tier === 'send_autonomous' && tool === 'store' && p.valid_until ? ` until ${p.valid_until.slice(0, 10)}` : ''})` : ''}`
    }
    return rows.map(r => {
      const d = r.detail ?? {}
      const ex = r.entity_id ? execMap.get(r.entity_id) : undefined
      const em = r.entity_id ? mailMap.get(r.entity_id) : undefined
      let what = WHAT[r.event] ?? r.event
      if (ex?.target_label) what += `: ${ex.target_label}${ex.field ? ` (${FIELD_WORDS[ex.field] ?? ex.field})` : ''}`
      if (em) what += `: ${em.task_key.replace(/_/g, ' ')} to ${em.to_addresses.length} recipient(s)`
      const reasons = Array.isArray(d.reasons) ? (d.reasons as string[]).join('; ') : null
      const blockers = Array.isArray(d.blockers) && (d.blockers as string[]).length ? `outside the rules: ${(d.blockers as string[]).join('; ')}` : null
      const why = str(d.reason) ?? reasons ?? blockers ?? (Array.isArray(d.expansion) && (d.expansion as string[]).length ? `widens: ${(d.expansion as string[]).join(', ')}` : null)
        ?? (d.trigger ? `trigger: ${String(d.trigger)}` : null)
      let permission: string
      if (/^(approval\.refused|task\.refused|execution\.blocked|email\.inbound\.)/.test(r.event)) permission = 'none: nothing was allowed or done'
      else if (r.event === 'approval.granted' || r.event === 'email.approved') permission = `your approval (${r.actor})`
      else if (r.event === 'approval.standing') permission = `standing ${versionWords(typeof d.policy_version === 'number' ? d.policy_version : null) ?? 'authorization'}`
      else if (r.event.startsWith('agent.') || r.event.startsWith('policy.') || r.event === 'task.cancelled' || r.event.startsWith('mailbox.')) permission = `you (${r.actor})`
      else if (ex) permission = ex.approver_kind === 'standing_authorization' ? `standing ${versionWords(ex.policy_version) ?? 'authorization'}` : ex.approved_by ? `your approval (${ex.approved_by})` : (versionWords(ex.policy_version) ?? 'unknown')
      else if (em) permission = em.approval_kind === 'standing' ? `standing ${versionWords(em.policy_version, 'email') ?? 'authorization'}` : em.approval_kind === 'individual' ? `your approval (${em.approved_by ?? 'you'})` : (versionWords(em.policy_version, 'email') ?? 'drafts only')
      else if (r.entity_id && propVersion.has(r.entity_id)) permission = `${versionWords(propVersion.get(r.entity_id)) ?? 'the agent\'s grant'} (recorded only; nothing changed)`
      else if (/^(scan|issue)\./.test(r.event)) permission = 'read access under the agent\'s grant (nothing changed)'
      else permission = versionWords(typeof d.policy_version === 'number' ? d.policy_version : typeof d.version === 'number' ? d.version : null) ?? 'none recorded'
      return { at: r.at, what, why, permission, event: r.event, actor: r.actor, ref: { type: r.entity_type, id: r.entity_id } }
    })
  })
}
