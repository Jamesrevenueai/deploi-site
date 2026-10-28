/**
 * Approval inbox: everything any agent is waiting on the merchant for, in one list.
 *  - changes: exact store changes. "approvable" ones (review mode, or outside a standing authorization)
 *    can be approved; drafts-only agents' changes can only be rejected (they may never be made).
 *  - emails: messages awaiting approval (approve or reject) and drafts (reject, or widen the agent).
 * Read under the merchant's RLS; approving and rejecting use the existing engine paths.
 */
import { withActor, type Actor } from '../engine/actor'
import { listMessages } from '../email/queries'

export type InboxChange = {
  id: string; issue_id: string; agent_id: string; agent_name: string; target_label: string | null; summary: string | null; severity: string
  change: { field: string; from: unknown; to: unknown }; change_hash: string; expires_at: string; created_at: string
  kind: 'draft' | 'approval'; why: string
}
export type InboxEmail = { id: string; agent_id: string | null; agent_name: string | null; status: string; status_reason: string | null; subject: string | null; to_addresses: string[]; created_at: string; content_hash: string }

export async function listInbox(actor: Actor): Promise<{ changes: InboxChange[]; emails: InboxEmail[] }> {
  const changes = await withActor(actor, db => db.query<InboxChange>(
    `select p.id, p.issue_id, p.agent_id, a.name as agent_name, p.target_label, i.evidence->>'summary' as summary, i.severity, p.change, p.change_hash, p.expires_at, p.created_at,
       case when coalesce(p.status_reason, '') like 'draft:%' then 'draft' else 'approval' end as kind,
       coalesce(regexp_replace(p.status_reason, '^(waiting for your approval|draft): ', ''), 'this agent asks before each change') as why
     from proposals p join agents a on a.id = p.agent_id join issues i on i.id = p.issue_id
     where p.status = 'pending_approval' and p.expires_at > now() and a.status <> 'deleted'
     order by (coalesce(p.status_reason, '') like 'draft:%'), i.severity = 'high' desc, p.created_at desc limit 200`))
  const [awaiting, drafts] = await Promise.all([listMessages(actor, { status: 'awaiting_approval', limit: 100 }), listMessages(actor, { status: 'draft', limit: 100 })])
  const emails = [...awaiting, ...drafts] as unknown as InboxEmail[]
  return { changes, emails }
}
