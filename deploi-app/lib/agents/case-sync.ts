/**
 * Case adapter for the Supplier Chaser's restock requests (supplier_requests, lib/agents/supplier.ts).
 *
 * One open `supplier_restock` case per agent and supplier: a request on a later day for the same supplier
 * joins the open case (its items are added) instead of opening another. The case follows the request:
 *
 *   drafted                 -> `proposed` (this agent only drafts)
 *   awaiting your approval  -> `awaiting_approval`
 *   being sent              -> `executing`
 *   sent / followed up      -> `waiting_external` until the supplier's reply is recorded (the send is an action)
 *   replied                 -> `verifying`: the reply is evidence, not a resolution
 *   not sent / unknown      -> `blocked` with the reason
 *
 * Resolved only when a fresh read of the store shows every requested item above the agent's threshold, or
 * closed by the owner with a reason (`cancelled`). Nothing here sends or changes anything.
 */
import { admin } from '../db'
import { log } from '../log'
import { addEvidence, caseForRecord, openCase, registerCaseKind, resolveCase, TERMINAL, type CaseRow } from '../cases'
import { ensureActionRecorded, ensureLink, isLinked, moveCase, type CaseTarget } from '../office/case-sync'
import { getConnector } from '../engine/registry'
import { loadConnection } from '../engine/scan'
import { registerCaseClose } from '../cases/close'

export const SUPPLIER_RESTOCK_KIND = 'supplier_restock'
const ACTOR = 'system:supplier-chaser'
const RECHECK_MS = 24 * 3600e3
export const restockDedupeKey = (agentId: string, supplier: string) => `supplier_restock:${agentId}:${supplier.toLowerCase()}`.slice(0, 300)

type ReqRow = { id: string; org_id: string; agent_id: string; connection_id: string; supplier_address: string; request_day: string; message_id: string | null; followup_message_id: string | null
  items: { variantId?: string; sku?: string | null; label?: string; available?: number }[]; status: string; status_reason: string | null; sent_at: string | null; followed_up_at: string | null
  replied_at: string | null; eta_date: string | null; eta_text: string | null; platform: string; threshold: number | null; agent_name: string }

const day = (v: string | Date) => new Date(v).toISOString().slice(0, 10)

function targetFor(r: ReqRow, now: Date): CaseTarget {
  const later = new Date(now.getTime() + RECHECK_MS)
  const who = r.supplier_address
  switch (r.status) {
    case 'drafted': return { status: 'proposed', reason: `Restock request to ${who} drafted: this agent only drafts, nothing goes out`, nextAction: 'Read the draft and send it yourself, or let the agent send requests you approve.', nextCheckAt: later }
    case 'awaiting_approval': return { status: 'awaiting_approval', reason: `The restock request to ${who} waits for your approval`, nextAction: 'Approve or decline the exact message in Needs My Approval.', nextCheckAt: later }
    case 'sending': return { status: 'executing', reason: `The restock request to ${who} is being sent`, nextAction: null, nextCheckAt: later }
    case 'sent': return { status: 'waiting_external', reason: `Sent to ${who} on ${day(r.sent_at ?? now)}: waiting for the supplier to reply`, nextAction: 'Nothing to do: the agent follows up once if there is no reply.', nextCheckAt: later }
    case 'followed_up': return { status: 'waiting_external', reason: `Followed up with ${who} on ${day(r.followed_up_at ?? now)}: waiting for the supplier to reply`, nextAction: 'Nothing to do: Deploi checks for the reply and the stock.', nextCheckAt: later }
    case 'replied': return { status: 'verifying', reason: `${who} replied${r.eta_date ? ` and mentions ${r.eta_date}` : ''}. The request counts as done once a fresh read shows the stock above ${r.threshold ?? 0}.`,
      nextAction: 'Nothing to do unless the stock does not arrive; you can close the case with a reason.', nextCheckAt: later }
    case 'unknown': return { status: 'blocked', reason: `Delivery of the request to ${who} is unknown${r.status_reason ? ` (${r.status_reason})` : ''}`, nextAction: "Check the mailbox's Sent folder; close the case or let the agent ask again.", nextCheckAt: later }
    default: return { status: 'blocked', reason: `The restock request to ${who} was not sent${r.status_reason ? `: ${r.status_reason}` : ''}`, nextAction: 'Fix the reason shown; the agent drafts again on its next run.', nextCheckAt: later }
  }
}

async function requestsOf(agentId: string, requestId?: string): Promise<ReqRow[]> {
  return admin(db => db.query<ReqRow>(
    `select r.id, r.org_id, r.agent_id, r.connection_id, r.supplier_address, to_char(r.request_day, 'YYYY-MM-DD') as request_day, r.message_id, r.followup_message_id, r.items, r.status, r.status_reason,
       r.sent_at, r.followed_up_at, r.replied_at, to_char(r.eta_date, 'YYYY-MM-DD') as eta_date, r.eta_text, c.platform, a.name as agent_name,
       nullif(ap.policy->'email'->'supplierReorder'->>'thresholdAvailable', '')::int as threshold
     from supplier_requests r join store_connections c on c.id = r.connection_id join agents a on a.id = r.agent_id left join agent_policies ap on ap.id = a.active_policy_id
     where r.agent_id = $1 and ($2::uuid is null or r.id = $2) and r.created_at > now() - interval '60 days' order by r.request_day, r.created_at`, [agentId, requestId ?? null]))
}

/** Open, update or link the restock case of every recent request of an agent. Idempotent. */
export async function syncRestockCases(agentId: string, opts: { now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date()
  const rows = await requestsOf(agentId)
  let n = 0
  for (const r of rows) {
    try { if (await syncRequest(r, now)) n++ } catch (e) { log.error('supplier.case_sync_failed', { request_id: r.id, error: (e as Error).message }) }
  }
  return n
}

async function syncRequest(r: ReqRow, now: Date): Promise<CaseRow | null> {
  const linked = await admin(db => caseForRecord(db, r.org_id, 'supplier_request', r.id))
  if (linked && TERMINAL.includes(linked.status)) return null
  // a later request to the same supplier has taken over this open case's status; older ones only add items
  let c = linked
  const items = (r.items ?? []).filter(i => typeof i.variantId === 'string')
  if (!c) {
    if (r.status === 'not_sent' && !r.message_id) return null
    c = (await admin(db => openCase(db, {
      orgId: r.org_id, suite: 'commerce', kind: SUPPLIER_RESTOCK_KIND, sourceApp: r.platform, dedupeKey: restockDedupeKey(r.agent_id, r.supplier_address),
      title: `Restock from ${r.supplier_address}: ${items.length} item${items.length === 1 ? '' : 's'} running low`.slice(0, 300),
      problem: `${items.map(i => `${i.label ?? i.variantId}${typeof i.available === 'number' ? ` (${i.available} left)` : ''}`).slice(0, 20).join('; ')}${items.length > 20 ? ` and ${items.length - 20} more` : ''}`.slice(0, 4000) || 'Items at or below the low-stock threshold.',
      whyItMatters: 'Once these sell out, customers cannot buy them until the supplier restocks.', priority: items.some(i => i.available === 0) ? 'high' : 'normal',
      agent: { kind: 'engine', ref: r.agent_id },
      evidence: [{ label: `${items.length} item${items.length === 1 ? '' : 's'} at or below ${r.threshold ?? 0} available`, source: r.platform, observedAt: new Date(`${r.request_day}T00:00:00Z`).toISOString(), detail: { items: items.slice(0, 50) } }],
      records: [{ type: 'supplier_request', id: r.id, label: `Request of ${r.request_day}` }, ...(r.message_id ? [{ type: 'email_message', id: r.message_id, label: 'Restock request' }] : []), ...items.slice(0, 40).map(i => ({ type: 'store_resource', id: String(i.variantId), label: (i.label ?? '').slice(0, 200) || undefined }))],
      verification: { criteria: `A fresh read of the store shows every requested item above ${r.threshold ?? 0} available (or you close it with a reason)`, rule: { type: 'restock_above', connectionId: r.connection_id, threshold: r.threshold ?? 0, agentId: r.agent_id } },
      nextCheckAt: new Date(now.getTime() + RECHECK_MS), actor: ACTOR,
    }))).case
    if (TERMINAL.includes(c.status)) return null
  }
  await ensureLink(c.id, { type: 'supplier_request', id: r.id, label: `Request of ${r.request_day}` }, ACTOR)
  if (r.message_id) await ensureLink(c.id, { type: 'email_message', id: r.message_id, label: 'Restock request' }, ACTOR)
  for (const i of items.slice(0, 40)) await ensureLink(c.id, { type: 'store_resource', id: String(i.variantId), label: i.label?.slice(0, 200) }, ACTOR)
  if (r.message_id && ['sent', 'followed_up', 'replied'].includes(r.status)) await ensureActionRecorded(c.id, { summary: `Restock request sent to ${r.supplier_address}`, ref: { type: 'email_sent', id: r.message_id }, detail: { sent_at: r.sent_at } }, ACTOR)
  if (r.followup_message_id && (r.status === 'followed_up' || (r.status === 'replied' && r.followed_up_at))) await ensureActionRecorded(c.id, { summary: `Followed up with ${r.supplier_address}`, ref: { type: 'email_sent', id: r.followup_message_id }, detail: { followed_up_at: r.followed_up_at } }, ACTOR)
  if (r.status === 'replied' && r.replied_at && !(await admin(db => isLinked(db, c!.id, 'supplier_reply', r.id)))) {
    await admin(async db => {
      await addEvidence(db, c!.id, { label: `${r.supplier_address} replied${r.eta_date ? `; a date is mentioned: ${r.eta_date} (read from the reply, not confirmed)` : ''}`, source: 'deploi_email', observedAt: r.replied_at!, detail: { eta: r.eta_date, eta_text: r.eta_text }, ref: { type: 'supplier_request', id: r.id } }, ACTOR)
      await db.query(`insert into case_links (case_id, org_id, ref_type, ref_id) values ($1,$2,'supplier_reply',$3) on conflict do nothing`, [c!.id, r.org_id, r.id])
    })
  }
  // the newest request linked to the case decides its status
  const newest = await admin(db => db.one<{ id: string }>(`select s.id from supplier_requests s join case_links l on l.ref_type = 'supplier_request' and l.ref_id = s.id::text and l.case_id = $1 order by s.request_day desc, s.created_at desc limit 1`, [c!.id]))
  if (newest && newest.id !== r.id) return c
  const t = targetFor(r, now)
  if (c.status === t.status && c.status_reason === t.reason) return c
  return moveCase(c.id, t, ACTOR)
}

/** Checker: a fresh read of every requested item; resolved only when all are above the threshold. */
export async function checkRestockCase(c: CaseRow, now: Date): Promise<void> {
  const rule = (c.verification as { rule?: { connectionId?: string; threshold?: number; agentId?: string } }).rule
  const later = () => admin(db => db.query('update cases set next_check_at = $2 where id = $1', [c.id, new Date(now.getTime() + RECHECK_MS).toISOString()]))
  if (!rule?.connectionId) return void (await later())
  // the reply may have arrived since the last run: bring the request (and so the case) up to date first
  if (rule.agentId) {
    const { syncSupplierRequests } = await import('./supplier')
    await syncSupplierRequests(rule.agentId).catch(() => undefined)
  }
  const fresh = await admin(db => db.one<CaseRow>('select * from cases where id = $1', [c.id]))
  if (!fresh || TERMINAL.includes(fresh.status)) return
  const ids = await admin(db => db.query<{ ref_id: string }>(`select ref_id from case_links where case_id = $1 and ref_type = 'store_resource'`, [c.id])).then(r => r.map(x => x.ref_id))
  const conn = await admin(db => loadConnection(db, rule.connectionId!))
  if (!conn || conn.status !== 'active' || !ids.length) return void (await later())
  const read = await getConnector(conn.platform).readResources(conn, ids).catch(() => null)
  if (!read) return void (await later())
  const threshold = rule.threshold ?? 0
  const levels = ids.map(id => {
    const r = read.get(id) ?? [...read.values()].find(x => String(x.variantId ?? '') === id) ?? null
    return { id, available: r && typeof r.totalAvailable === 'number' ? (r.totalAvailable as number) : null, label: r ? String(r.productTitle ?? id) : id, at: r?.fetchedAt ?? now.toISOString() }
  })
  if (levels.every(l => l.available !== null && l.available > threshold)) {
    await admin(db => resolveCase(db, c.id, { actor: ACTOR, summary: `Restocked: every requested item is above ${threshold} available`, verifiedBy: `${conn.platform} read`,
      evidence: levels.map(l => ({ label: `${l.label}: ${l.available} available`, source: conn.platform, observedAt: l.at, detail: { available: l.available, threshold }, ref: { type: 'store_resource', id: l.id } })) }))
    return
  }
  const low = levels.filter(l => l.available === null || l.available <= threshold)
  await admin(db => db.query(`insert into case_events (case_id, org_id, actor, type, summary, detail) values ($1,$2,$3,'note',$4,$5)`,
    [c.id, c.org_id, ACTOR, `Checked the store: ${low.length} of ${levels.length} item${levels.length === 1 ? '' : 's'} still at or below ${threshold}`.slice(0, 1000), JSON.stringify({ low: low.map(l => ({ id: l.id, available: l.available })) })]))
  await later()
}

registerCaseKind(SUPPLIER_RESTOCK_KIND, checkRestockCase)
registerCaseClose(SUPPLIER_RESTOCK_KIND, { label: 'Close this restock request', needsReason: true })
