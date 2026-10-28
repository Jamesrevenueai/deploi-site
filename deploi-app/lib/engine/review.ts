/**
 * Merchant decisions on issues: exempt a product (a durable merchant rule), acknowledge a
 * needs-a-person issue, or confirm that Deploi may propose again after a revert (loop guard).
 */
import { admin } from '../db'
import { audit } from './audit'
import { assertMerchant, withActor, type Actor } from './actor'
import { EngineError } from './errors'
import { invalidateProposal, type ProposalRow } from './proposals'
import { updateRule } from './rules'
import type { IssueRow } from './scan'

async function visibleIssue(actor: Actor, issueId: string, ip?: string | null) {
  const v = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from issues where id = $1', [issueId]), { ip })
  if (!v) throw new EngineError('not_found', 'issue not found')
  assertMerchant(actor, v.org_id)
  return v
}

/** Acknowledge an issue. It stays closed until its evidence changes (its fingerprint changes). */
export async function dismissIssue(actor: Actor, issueId: string, note: string, opts: { ip?: string | null } = {}) {
  await visibleIssue(actor, issueId, opts.ip)
  return admin(async db => {
    const i = await db.one<IssueRow>('select * from issues where id = $1 for update', [issueId])
    if (!i || !['open', 'needs_review'].includes(i.status)) throw new EngineError('not_pending', 'issue is not open')
    await db.query(`update issues set status = 'dismissed', resolution = 'dismissed_by_merchant', resolved_at = now(), status_reason = $2 where id = $1`, [i.id, note.slice(0, 500) || 'acknowledged'])
    const props = await db.query<ProposalRow>(`select * from proposals where issue_id = $1 and status in ('pending_approval','approved')`, [i.id])
    for (const p of props) await invalidateProposal(db, p, 'dismissed', 'issue dismissed by the merchant', actor.label)
    await audit(db, { orgId: i.org_id, connectionId: i.connection_id, entityType: 'issue', entityId: i.id, event: 'issue.dismissed', actor: actor.label, detail: { note } })
  })
}

/** Exempt the product behind an issue from its check: recorded in the merchant rule (version bump). */
export async function exemptProduct(actor: Actor, issueId: string, opts: { ip?: string | null } = {}) {
  await visibleIssue(actor, issueId, opts.ip)
  return admin(async db => {
    const i = await db.one<IssueRow>('select * from issues where id = $1', [issueId])
    const productId = String((i!.evidence as Record<string, unknown>).productId ?? '')
    if (!productId) throw new EngineError('invalid_input', 'this issue has no product to exempt')
    const rule = await db.one<{ config: Record<string, unknown> }>('select config from merchant_rules where connection_id = $1 and check_key = $2', [i!.connection_id, i!.check_key])
    const cur = Array.isArray(rule?.config.exemptProductIds) ? (rule!.config.exemptProductIds as string[]) : []
    if (!cur.includes(productId)) await updateRule(db, { connectionId: i!.connection_id, checkKey: i!.check_key, config: { ...rule!.config, exemptProductIds: [...cur, productId] }, actor: actor.label })
    await db.query(`update issues set status = 'dismissed', resolution = 'dismissed_by_merchant', resolved_at = now(), status_reason = 'product exempted by the merchant' where id = $1 and status in ('open','needs_review')`, [i!.id])
    const props = await db.query<ProposalRow>(`select * from proposals where issue_id = $1 and status in ('pending_approval','approved')`, [i!.id])
    for (const p of props) await invalidateProposal(db, p, 'dismissed', 'product exempted by the merchant', actor.label)
    await audit(db, { orgId: i!.org_id, connectionId: i!.connection_id, entityType: 'issue', entityId: i!.id, event: 'issue.exempted', actor: actor.label, detail: { product_id: productId } })
  })
}

/** After a revert, the merchant confirms Deploi may propose the change again (clears the loop guard for this issue). */
export async function confirmReproposal(actor: Actor, issueId: string, opts: { ip?: string | null } = {}) {
  await visibleIssue(actor, issueId, opts.ip)
  return admin(async db => {
    const r = await db.query<IssueRow>(`update issues set status = 'open', status_reason = 'merchant confirmed a new proposal', guard_cleared_at = now() where id = $1 and status = 'needs_review' returning *`, [issueId])
    if (!r.length) throw new EngineError('not_pending', 'issue is not waiting for review')
    await audit(db, { orgId: r[0].org_id, connectionId: r[0].connection_id, entityType: 'issue', entityId: issueId, event: 'issue.guard_cleared', actor: actor.label })
  })
}
