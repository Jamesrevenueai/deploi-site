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

function item(a: OfficeApproval): ApprovalItem {
  return {
    source: 'office', id: a.id, orgId: a.orgId, kind: `office_${a.kind}`, title: title(a),
    agent: { id: a.agentId, name: a.agentName }, createdAt: new Date(a.createdAt).toISOString(), expiresAt: null,
    version: a.payloadHash, decisions: ['approve', 'reject'], why: a.statusReason,
    content: { purpose: a.purpose, action: a.kind, agentKind: a.agentKind, policyVersion: a.policyVersion, ...(a.payload as unknown as Record<string, unknown>) },
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
