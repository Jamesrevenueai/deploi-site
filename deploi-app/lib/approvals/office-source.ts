/**
 * Deploi Office actions in the unified approvals inbox. The exact email text and event details are not
 * readable by user sessions, so this source reads them as the service role for the organization the
 * registry already resolved from the actor (never from the request). Decisions go through Office's own
 * path, which re-checks the actor, the agent, its tier and the payload hash under a row lock.
 */
import { admin } from '../db'
import { approveOfficeAction, listOfficePendingApprovals, rejectOfficeAction, type OfficeApproval } from '../office/approvals'
import type { ApprovalItem, ApprovalSource } from './registry'

function title(a: OfficeApproval): string {
  const p = a.payload as unknown as Record<string, unknown>
  if (p.type === 'email') return `Send "${String(p.subject ?? 'message')}" to ${String(p.to ?? '')}`
  if (p.type === 'event') return `Book "${String(p.summary ?? 'meeting')}"`
  return a.purpose || a.kind.replace(/_/g, ' ')
}

/** internal bookkeeping on a payload: never sent, so not part of what the owner reads */
const INTERNAL = new Set(['type', 'meta', 'recipientSource', 'inReplyToMessageId', 'eventId', 'externalId'])

/**
 * What the owner reads before deciding: the recipient, subject and full text (or the event / CRM change) exactly
 * as it will go out, then the purpose. Internal ids and bookkeeping stay out; the approval is still bound to the
 * hash of the whole payload, so nothing hidden here can change after approval.
 */
export function shownContent(a: Pick<OfficeApproval, 'purpose' | 'payload'>): Record<string, unknown> {
  const p = a.payload as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of ['to', 'cc', 'subject', 'body', 'summary', 'start', 'end', 'attendees', 'description']) if (p[k] != null && p[k] !== '') out[k] = p[k]
  for (const [k, v] of Object.entries(p)) if (!(k in out) && !INTERNAL.has(k) && v != null && v !== '') out[k] = v
  out.purpose = a.purpose
  return out
}

function item(a: OfficeApproval): ApprovalItem {
  return {
    source: 'office', id: a.id, orgId: a.orgId, kind: `office_${a.kind}`, title: title(a),
    agent: { id: a.agentId, name: a.agentName }, createdAt: new Date(a.createdAt).toISOString(), expiresAt: null,
    version: a.payloadHash, decisions: ['approve', 'reject'], why: a.statusReason,
    content: shownContent(a),
  }
}

export const officeSource: ApprovalSource = {
  key: 'office',
  label: 'Office',
  async list(_db, orgId) { return (await admin(db => listOfficePendingApprovals(db, orgId))).map(item) },
  async find(_db, orgId, id) {
    const all = await admin(db => listOfficePendingApprovals(db, orgId))
    const a = all.find(x => x.id === id && x.orgId === orgId)
    return a ? item(a) : null
  },
  async decide(_db, actor, id, decision, input) {
    if (decision === 'approve') { const r = await approveOfficeAction(actor, id, input.version); return { status: r.status, reason: r.reason } }
    const r = await rejectOfficeAction(actor, id)
    return { status: r.status }
  },
}
