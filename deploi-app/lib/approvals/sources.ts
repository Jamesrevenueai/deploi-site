/**
 * Built-in approval sources. Each lists through the actor's RLS view and decides through the path that
 * already enforces its rules: engine proposals (approveAndExecute / dismissIssue), agent emails
 * (approveMessage / editMessage / declineMessage) and library actions (approveAction / declineAction).
 * Versions are content hashes: the proposal's change_hash, the email's content_hash, and for library
 * actions a hash of everything the approval covers (they have no stored hash).
 */
import { createHash } from 'node:crypto'
import { admin } from '../db'
import { canonicalJson } from '../engine/hash'
import { approveAndExecute } from '../engine/execute'
import { dismissIssue } from '../engine/review'
import { approveMessage, declineMessage, editMessage } from '../email/engine'
import { decryptContent } from '../email/content'
import { unsubscribeFooter } from '../email/unsubscribe'
import { approveAction, declineAction } from '../library/actions'
import type { ApprovalItem, ApprovalSource } from './registry'

// ---------------------------------------------------------------- engine proposals (store changes)
type PropRow = { id: string; org_id: string; issue_id: string; agent_id: string | null; agent_name: string | null; target_label: string | null; target_type: string; target_id: string; action_key: string
  change: { field: string; from: unknown; to: unknown; params?: unknown }; change_hash: string; expires_at: string; created_at: string; status_reason: string | null
  evidence: Record<string, unknown>; severity: string; check_key: string; drafts_only: boolean }

const PROP_SQL = `select p.id, p.org_id, p.issue_id, p.agent_id, a.name as agent_name, p.target_label, p.target_type, p.target_id, p.action_key, p.change, p.change_hash, p.expires_at, p.created_at, p.status_reason,
    i.evidence, i.severity, i.check_key,
    (coalesce(p.status_reason, '') like 'draft:%' or (a.id is not null and coalesce(ap.policy->>'approvalMode', 'review') = 'draft')) as drafts_only
  from proposals p join issues i on i.id = p.issue_id left join agents a on a.id = p.agent_id left join agent_policies ap on ap.id = a.active_policy_id
  where p.org_id = $1 and p.status = 'pending_approval' and p.expires_at > now() and (p.agent_id is null or a.status <> 'deleted')`

function proposalItem(p: PropRow): ApprovalItem {
  const { params, ...change } = p.change
  return {
    source: 'engine', id: p.id, orgId: p.org_id, kind: 'store_change',
    title: `Change ${change.field} on ${p.target_label ?? p.target_id}`,
    agent: p.agent_id ? { id: p.agent_id, name: p.agent_name } : null,
    createdAt: new Date(p.created_at).toISOString(), expiresAt: new Date(p.expires_at).toISOString(), version: p.change_hash,
    decisions: p.drafts_only ? ['reject'] : ['approve', 'reject'],
    why: p.status_reason?.replace(/^(waiting for your approval|draft): /, '') ?? (p.agent_id ? 'this agent asks before each change' : 'your store rule asks before each change'),
    content: { target: { type: p.target_type, id: p.target_id, label: p.target_label }, action: p.action_key, field: change.field, from: change.from, to: change.to, params: params ?? null,
      check: p.check_key, severity: p.severity, summary: p.evidence?.summary ?? null, evidence: p.evidence },
  }
}

export const engineSource: ApprovalSource = {
  key: 'engine',
  label: 'Store changes',
  async list(db, orgId) { return (await db.query<PropRow>(`${PROP_SQL} order by p.created_at desc limit 300`, [orgId])).map(proposalItem) },
  async find(db, orgId, id) { const r = await db.one<PropRow>(`${PROP_SQL} and p.id = $2`, [orgId, id]); return r ? proposalItem(r) : null },
  async decide(db, actor, id, decision, input) {
    if (decision === 'approve') return { ...(await approveAndExecute(actor, id, input.version, { ip: input.ip })) }
    const p = await db.one<{ issue_id: string }>('select issue_id from proposals where id = $1', [id])
    await dismissIssue(actor, p!.issue_id, (input.reason ?? 'rejected in approvals').slice(0, 500), { ip: input.ip })
    return { status: 'rejected' }
  },
}

// ---------------------------------------------------------------- agent emails
type MailRow = { id: string; org_id: string; agent_id: string | null; agent_name: string | null; status: string; status_reason: string | null; task_key: string; from_address: string; to_addresses: string[]; cc_addresses: string[]
  content_hash: string; created_at: string; attachment_count: number }
const MAIL_SQL = `select m.id, m.org_id, m.agent_id, g.name as agent_name, m.status, m.status_reason, m.task_key, m.from_address, m.to_addresses, m.cc_addresses, m.content_hash, m.created_at, m.attachment_count
  from email_messages m left join agents g on g.id = m.agent_id where m.org_id = $1 and m.status in ('awaiting_approval', 'draft') and m.office_agent_id is null`

async function mailItems(rows: MailRow[]): Promise<ApprovalItem[]> {
  if (!rows.length) return []
  // decrypted only after the RLS read above showed the caller these rows
  const enc = await admin(db => db.query<{ id: string; key_id: string; content_ciphertext: string }>('select id, key_id, content_ciphertext from email_messages where id = any($1::uuid[])', [rows.map(r => r.id)]))
  const byId = new Map(enc.map(e => [e.id, e]))
  return rows.map(m => {
    let c: ReturnType<typeof decryptContent> | null = null
    try { const e = byId.get(m.id); if (e) c = decryptContent(m.id, e.key_id, e.content_ciphertext) } catch { c = null }
    return {
      source: 'email', id: m.id, orgId: m.org_id, kind: 'email',
      title: `Send "${c?.subject ?? 'message'}" to ${m.to_addresses.join(', ')}`,
      agent: { id: m.agent_id, name: m.agent_name }, createdAt: new Date(m.created_at).toISOString(), expiresAt: null, version: m.content_hash,
      decisions: m.status === 'awaiting_approval' ? ['approve', 'reject'] : ['reject'],
      why: m.status_reason,
      content: { from: m.from_address, to: m.to_addresses, cc: m.cc_addresses, subject: c?.subject ?? null, body: c?.bodyText ?? null, task: m.task_key,
        attachments: c?.attachments.map(a => ({ filename: a.filename, contentType: a.contentType, bytes: Math.floor(a.contentBase64.length * 3 / 4) })) ?? [],
        addedAtSend: m.task_key === 'human_reply' ? null : unsubscribeFooter('<signed unsubscribe link>').trim() },
    }
  })
}

export const emailSource: ApprovalSource = {
  key: 'email',
  label: 'Emails',
  async list(db, orgId) { return mailItems(await db.query<MailRow>(`${MAIL_SQL} order by m.created_at desc limit 200`, [orgId])) },
  async find(db, orgId, id) { const r = await db.one<MailRow>(`${MAIL_SQL} and m.id = $2`, [orgId, id]); return r ? (await mailItems([r]))[0] : null },
  async decide(_db, actor, id, decision, input) {
    if (decision === 'reject') { await declineMessage(actor, id); return { status: 'cancelled' } }
    let hash = input.version
    const ed = input.edits ?? {}
    if (typeof ed.subject === 'string' || typeof ed.bodyText === 'string') {
      // the person's own edit: the approval binds to the edited content they sent
      hash = (await editMessage(actor, id, { shownHash: hash, subject: typeof ed.subject === 'string' ? ed.subject : undefined, bodyText: typeof ed.bodyText === 'string' ? ed.bodyText : undefined })).contentHash
    }
    return { ...(await approveMessage(actor, id, hash)) }
  },
}

// ---------------------------------------------------------------- library actions
type LibRow = { id: string; org_id: string; agent_key: string; action_type: string; title: string; summary: string; evidence: Record<string, unknown>; payload: Record<string, unknown>
  status: string; permission_basis: string | null; created_at: string; expires_at: string | null }
const LIB_SQL = `select id, org_id, agent_key, action_type, title, summary, evidence, payload, status, permission_basis, created_at, expires_at from library_actions where org_id = $1 and status = 'draft'`

export const libraryVersion = (a: Pick<LibRow, 'id' | 'action_type' | 'title' | 'summary' | 'evidence' | 'payload' | 'status' | 'expires_at'>) =>
  createHash('sha256').update(canonicalJson({ v: 1, id: a.id, actionType: a.action_type, title: a.title, summary: a.summary, evidence: a.evidence, payload: a.payload, status: a.status, expiresAt: a.expires_at ? new Date(a.expires_at).toISOString() : null })).digest('hex')

function libItem(a: LibRow): ApprovalItem {
  return {
    source: 'library', id: a.id, orgId: a.org_id, kind: 'library_action', title: a.title,
    agent: { id: null, name: a.agent_key }, createdAt: new Date(a.created_at).toISOString(), expiresAt: a.expires_at ? new Date(a.expires_at).toISOString() : null,
    version: libraryVersion(a), decisions: ['approve', 'reject'], why: a.permission_basis,
    content: { actionType: a.action_type, summary: a.summary, from: a.payload.from ?? null, to: a.payload.to ?? null, payload: a.payload, evidence: a.evidence },
  }
}

export const librarySource: ApprovalSource = {
  key: 'library',
  label: 'Agent library',
  async list(db, orgId) { return (await db.query<LibRow>(`${LIB_SQL} order by created_at desc limit 300`, [orgId])).map(libItem) },
  async find(db, orgId, id) { const r = await db.one<LibRow>(`${LIB_SQL} and id = $2`, [orgId, id]); return r ? libItem(r) : null },
  async decide(_db, actor, id, decision, input) {
    if (decision === 'reject') { await declineAction(actor, id, input.reason); return { status: 'declined' } }
    return { ...(await approveAction(actor, id)) }
  },
}

export const BUILT_IN_SOURCES = [engineSource, emailSource, librarySource]

