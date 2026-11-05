/**
 * Purchase-order resolution options in the unified approvals inbox. Each option changes a purchase order, so it
 * waits for the owner: listed through the actor's RLS view, versioned by the option's change hash, decided through
 * decideResolution (which re-checks the hash, the organization stop and every field's current value under a lock).
 */
import type { ApprovalItem, ApprovalSource } from '../approvals/registry'
import { decideResolution, type ResolutionRow } from './supplier-coordinator'

type Row = ResolutionRow & { case_ref: string; agent_ref: string | null; po_number: string; supplier_email: string; case_reason: string | null }

const SQL = `select r.id, r.org_id, r.case_id, r.po_id, r.kind, r.summary, r.change, r.change_hash, r.reply_id, r.status, r.status_reason, r.created_at,
    c.ref as case_ref, c.agent_ref, c.status_reason as case_reason, p.po_number, p.supplier_email
  from purchase_order_resolutions r join cases c on c.id = r.case_id join purchase_orders p on p.id = r.po_id
  where r.org_id = $1 and r.status = 'proposed' and c.status = 'awaiting_approval'`

function item(r: Row): ApprovalItem {
  return {
    source: 'purchase_orders', id: r.id, orgId: r.org_id, kind: `po_${r.kind}`, title: `PO ${r.po_number}: ${r.summary}`.slice(0, 300),
    agent: r.agent_ref ? { id: r.agent_ref, name: 'Supplier Coordinator' } : null, createdAt: new Date(r.created_at).toISOString(), expiresAt: null,
    version: r.change_hash, decisions: ['approve', 'reject'], why: 'This option changes your purchase order, so it needs your approval of the exact change.',
    content: { case: r.case_ref, purchaseOrder: r.po_number, supplier: r.supplier_email, option: r.kind, summary: r.summary, changes: r.change.changes, reorder: r.change.reorder ?? null },
  }
}

export const purchaseOrderSource: ApprovalSource = {
  key: 'purchase_orders',
  label: 'Purchase orders',
  async list(db, orgId) { return (await db.query<Row>(`${SQL} order by r.created_at, r.id`, [orgId])).map(item) },
  async find(db, orgId, id) { const r = await db.one<Row>(`${SQL} and r.id = $2`, [orgId, id]); return r ? item(r) : null },
  async decide(_db, actor, id, decision, input) {
    const r = await decideResolution(actor, id, input.version, decision)
    return { status: r.status, caseStatus: r.caseStatus, reason: r.reason ?? null }
  },
}
