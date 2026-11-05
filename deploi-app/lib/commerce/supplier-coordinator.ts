/**
 * Supplier Coordinator: carries each supplier exception on a purchase order from detection to a verified
 * outcome on the Resolution Engine (lib/cases).
 *
 *   detected -> (message to the PO's supplier: draft / awaiting approval / sent by the agent's email tier)
 *            -> waiting_external (next check = no reply after N days -> one follow-up -> escalate)
 *   reply    -> parsed as data (lib/commerce/supplier-replies.ts)
 *            -> ambiguous: investigating + a clarification draft in the same thread
 *            -> clear: proposed with resolution options -> awaiting_approval (each option changes the PO)
 *   owner approves one option (bound to its change hash) -> executing: the PO record is updated (audited)
 *            -> verifying -> resolved only when the PO record shows the agreed state; deliveries are monitored
 *               (waiting_external until the revised date; received quantities resolve, a missed date escalates).
 *
 * Rules: recipients are only the PO's own supplier email (and only if the agent's grant allows that address);
 * every message goes through the email engine (tier, exact-content approval, live-send gate, one send per row);
 * replies are data and can never add a recipient, change a permission or change a PO by themselves; an action
 * (a sent message, an applied option) never resolves a case; an organization stop halts the flow.
 */
import { createHash } from 'node:crypto'
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { canonicalJson } from '../engine/hash'
import { orgStopReason } from '../engine/kill-switch'
import { authorizeAgentAction } from '../engine/authorize'
import { decryptSecret } from '../connectors/credentials'
import { parsePolicy, recipientAllowed, type AgentPolicy } from '../agents/policy'
import { createAgentMessages, processQueue } from '../email/engine'
import type { DraftMessage } from '../email/tasks'
import {
  addEvidence, canTransition, handOffCase, linkRecord, openCase, recordAction, registerCaseKind, resolveCase, transitionCase,
  TERMINAL, type CaseRow, type CaseStatus, type Evidence,
} from '../cases'
import { fullyReceived, isoDate, loadPo, openLines, refreshStatus, type PurchaseOrder } from './purchase-orders'
import { DEFAULT_EXCEPTION_SETTINGS, EXCEPTION_LABEL, findSupplierExceptions, priceDiffers, SUPPLIER_EXCEPTION_KIND, type ExceptionRule, type ExceptionSettings } from './supplier-exceptions'
import { parseSupplierReply, type ParsedReply, type ReplyAttachment } from './supplier-replies'

export const COORDINATOR_TASK = 'supplier_exception' as const
const FOLLOWUP_DAYS = 3
const GRACE_DAYS = 1
const OPEN_DRAFT = ['draft', 'awaiting_approval', 'queued']
const day = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (d: Date | string, n: number) => new Date(new Date(typeof d === 'string' && d.length === 10 ? `${d}T00:00:00Z` : d).getTime() + n * 864e5)
const clean = (s: unknown, max = 200) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const money = (n: number, cur: string) => `${n.toFixed(2)} ${cur}`

// ---------------------------------------------------------------- lifecycle helper

/** Move a case to `to`, through the shortest allowed path of working statuses (e.g. waiting_external -> investigating -> proposed). */
export async function moveCase(db: Db, caseId: string, to: CaseStatus, t: { actor: string; reason: string; nextAction?: string | null; nextCheckAt?: Date | null; approvalRequired?: boolean; evidence?: Evidence[]; ref?: { type: string; id: string } | null }): Promise<CaseRow> {
  const c = (await db.one<CaseRow>('select * from cases where id = $1', [caseId]))!
  if (c.status === to) {
    if (t.nextCheckAt !== undefined || t.nextAction !== undefined || t.approvalRequired !== undefined)
      await db.query(`update cases set next_check_at = case when $2::boolean then $3::timestamptz else next_check_at end, next_action = case when $4::boolean then $5 else next_action end,
        approval_required = coalesce($6, approval_required), status_reason = $7 where id = $1`,
        [c.id, t.nextCheckAt !== undefined, t.nextCheckAt?.toISOString() ?? null, t.nextAction !== undefined, t.nextAction ?? null, t.approvalRequired ?? null, t.reason.slice(0, 1000)])
    return (await db.one<CaseRow>('select * from cases where id = $1', [caseId]))!
  }
  const WORK: CaseStatus[] = ['investigating', 'proposed', 'awaiting_approval', 'executing', 'waiting_external', 'verifying']
  const prev = new Map<CaseStatus, CaseStatus>()
  const queue: CaseStatus[] = [c.status]
  while (queue.length && !prev.has(to)) {
    const s = queue.shift()!
    for (const n of [...WORK, to]) if (n !== c.status && !prev.has(n) && canTransition(s, n)) { prev.set(n, s); queue.push(n) }
  }
  if (!prev.has(to)) throw new EngineError('invalid_input', `a case cannot go from ${c.status} to ${to}`)
  const path: CaseStatus[] = []
  for (let s: CaseStatus | undefined = to; s && s !== c.status; s = prev.get(s)) path.unshift(s)
  let row = c
  for (const s of path) {
    const last = s === to
    row = await transitionCase(db, caseId, last ? { to: s, ...t } : { to: s, actor: t.actor, reason: t.reason })
  }
  return row
}

// ---------------------------------------------------------------- rule: what the PO record must show

export function ruleOf(c: Pick<CaseRow, 'verification'>): ExceptionRule | null {
  const r = (c.verification as { rule?: ExceptionRule }).rule
  return r && typeof r.poId === 'string' && typeof r.type === 'string' ? r : null
}

/** Does the PO record show the agreed state this case needs? Fresh read of the source of truth, no guessing. */
export function ruleMet(rule: ExceptionRule, po: PurchaseOrder): { met: boolean; observed: string } {
  const open = openLines(po)
  if (!open.length || po.status === 'cancelled') return { met: true, observed: `PO ${po.po_number}: every line is cancelled` }
  const list = (f: (l: (typeof open)[number]) => string) => open.slice(0, 20).map(f).join('; ')
  switch (rule.type) {
    case 'missing_confirmation': {
      const met = open.every(l => l.qty_confirmed !== null)
      return { met, observed: `PO ${po.po_number} (${po.status}): ${list(l => `${l.sku} confirmed ${l.qty_confirmed ?? 'not yet'}`)}${po.confirmed_expected_at ? `; delivery ${po.confirmed_expected_at}` : ''}` }
    }
    case 'quantity_discrepancy': {
      const met = open.every(l => (l.qty_confirmed === null || l.qty_confirmed === l.qty_ordered) && (rule.requireReceipt ? l.qty_received >= l.qty_ordered : (l.qty_received === 0 || l.qty_received === l.qty_ordered)))
      return { met, observed: `PO ${po.po_number}: ${list(l => `${l.sku} ordered ${l.qty_ordered}, confirmed ${l.qty_confirmed ?? '-'}, received ${l.qty_received}`)}` }
    }
    case 'delivery_delay': {
      const met = fullyReceived(po)
      return { met, observed: `PO ${po.po_number}: ${list(l => `${l.sku} received ${l.qty_received} of ${l.qty_ordered}`)}${po.expected_at ? `; expected ${po.expected_at}` : ''}` }
    }
    case 'price_change': {
      const met = open.every(l => l.unit_price_confirmed === null || !priceDiffers(l.unit_price_ordered, l.unit_price_confirmed, rule.priceTolerancePct))
      return { met, observed: `PO ${po.po_number}: ${list(l => `${l.sku} ordered at ${money(l.unit_price_ordered, po.currency)}${l.unit_price_confirmed !== null ? `, confirmed at ${money(l.unit_price_confirmed, po.currency)}` : ''}`)}` }
    }
  }
}

// ---------------------------------------------------------------- agent

type Coordinator = { agentId: string; orgId: string; name: string; policy: AgentPolicy; storeName: string }

async function loadCoordinator(db: Db, agentId: string): Promise<Coordinator | null> {
  const a = await db.one<{ id: string; org_id: string; name: string; status: string; policy: unknown; store: string | null }>(
    `select a.id, a.org_id, a.name, a.status, p.policy, coalesce(c.display_name, c.external_id) as store from agents a
     join agent_policies p on p.id = a.active_policy_id and p.status = 'active' left join store_connections c on c.id = a.connection_id where a.id = $1`, [agentId])
  if (!a) return null
  let policy: AgentPolicy
  try { policy = parsePolicy(a.policy) } catch { return null }
  if (!policy.email?.tasks.includes(COORDINATOR_TASK)) return null
  return { agentId: a.id, orgId: a.org_id, name: a.name, policy, storeName: (a.store ?? 'the store').replace(/\s*\(synthetic\)$/, '') }
}

/** The organization's active Supplier Coordinator (an agent whose granted email tasks include supplier exceptions). */
export async function coordinatorOf(db: Db, orgId: string): Promise<string | null> {
  const rows = await db.query<{ id: string; policy: unknown }>(`select a.id, p.policy from agents a join agent_policies p on p.id = a.active_policy_id and p.status = 'active'
    where a.org_id = $1 and a.status = 'active' order by a.created_at`, [orgId])
  for (const r of rows) { try { if (parsePolicy(r.policy).email?.tasks.includes(COORDINATOR_TASK)) return r.id } catch { /* unreadable policy: not a coordinator */ } }
  return null
}

// ---------------------------------------------------------------- detection -> cases

/**
 * Open (or re-detect) one case per PO and exception type. Cases are assigned to the coordinator when there is
 * one; otherwise they wait unassigned (discovery recommends the Supplier Coordinator).
 */
export async function openSupplierExceptionCases(orgId: string, opts: { now?: Date; actor: string; poIds?: string[]; settings?: ExceptionSettings }): Promise<{ opened: string[]; redetected: string[] }> {
  const now = opts.now ?? new Date()
  return admin(async db => {
    const { exceptions } = await findSupplierExceptions(db, orgId, now, opts.settings ?? DEFAULT_EXCEPTION_SETTINGS)
    const agentId = await coordinatorOf(db, orgId)
    const out = { opened: [] as string[], redetected: [] as string[] }
    for (const x of exceptions) {
      if (opts.poIds && !opts.poIds.includes(x.po.id)) continue
      const platform = x.po.connection_id ? (await db.one<{ platform: string }>('select platform from store_connections where id = $1', [x.po.connection_id]))?.platform : null
      const r = await openCase(db, {
        orgId, suite: 'commerce', kind: SUPPLIER_EXCEPTION_KIND, sourceApp: platform ?? 'import', dedupeKey: x.dedupeKey,
        title: x.title, problem: x.problem, whyItMatters: x.whyItMatters, priority: x.priority, evidence: x.evidence,
        records: [{ type: 'purchase_order', id: x.po.id, label: `PO ${x.po.po_number}` }], verification: x.verification,
        agent: agentId ? { kind: 'engine', ref: agentId } : null, nextAction: agentId ? 'The Supplier Coordinator will prepare a message to the supplier' : 'Create a Supplier Coordinator to work on this with the supplier',
        actor: opts.actor,
      })
      ;(r.created ? out.opened : out.redetected).push(r.case.id)
    }
    return out
  })
}

// ---------------------------------------------------------------- messages to the supplier (exact content)

type MsgKind = 'request' | 'clarify' | 'followup'

function lineList(po: PurchaseOrder, rule: ExceptionRule): string[] {
  const open = openLines(po)
  const desc = (l: (typeof open)[number]) => `${clean(l.sku, 60)}${l.description ? ` · ${clean(l.description, 80)}` : ''}`
  switch (rule.type) {
    case 'missing_confirmation': return open.map(l => `- ${desc(l)} · ordered: ${l.qty_ordered} · unit price: ${money(l.unit_price_ordered, po.currency)}`)
    case 'quantity_discrepancy': return open.filter(l => (l.qty_confirmed !== null && l.qty_confirmed !== l.qty_ordered) || l.qty_received !== l.qty_ordered)
      .map(l => `- ${desc(l)} · ordered: ${l.qty_ordered}${l.qty_confirmed !== null ? ` · confirmed: ${l.qty_confirmed}` : ''} · received: ${l.qty_received}`)
    case 'delivery_delay': return open.filter(l => l.qty_received < l.qty_ordered).map(l => `- ${desc(l)} · ordered: ${l.qty_ordered} · received: ${l.qty_received}`)
    case 'price_change': return open.filter(l => l.unit_price_confirmed !== null && priceDiffers(l.unit_price_ordered, l.unit_price_confirmed, rule.priceTolerancePct))
      .map(l => `- ${desc(l)} · ordered at: ${money(l.unit_price_ordered, po.currency)} · your confirmation: ${money(l.unit_price_confirmed!, po.currency)}`)
  }
}

/** The exact message for a case. Recipient: the PO's supplier email, nothing else, ever. */
export function supplierMessage(kind: MsgKind, f: { caseId: string; po: PurchaseOrder; rule: ExceptionRule; agentName: string; storeName: string; reasons?: string[]; replyId?: string; previous?: { internetMessageId: string; subject: string; sentAt: string | null } | null }): DraftMessage {
  const { po, rule } = f
  const hello = `Hello${po.supplier_name ? ` ${clean(po.supplier_name, 80)}` : ''},`
  const intro = `${clean(f.storeName, 120)} is writing about purchase order ${clean(po.po_number, 64)} dated ${po.ordered_at}.`
  const ask = 'Please reply to this email with, for each SKU, the quantity you will deliver, the unit price and the delivery date.'
  let subject: string, body: string[]
  if (kind === 'request') {
    const para = rule.type === 'missing_confirmation' ? 'We have not yet received your confirmation of this order. Please confirm the quantities, unit prices and delivery date for each line:'
      : rule.type === 'quantity_discrepancy' ? 'The quantities we have from you differ from the order:'
      : rule.type === 'delivery_delay' ? (po.expected_at && po.confirmed_expected_at && po.confirmed_expected_at > po.expected_at
        ? `Your delivery date (${po.confirmed_expected_at}) is later than the date on the order (${po.expected_at}). These lines are outstanding:`
        : `The order was due on ${po.expected_at ?? 'the agreed date'}, and these lines have not arrived in full:`)
      : 'The unit prices you confirmed differ from the order:'
    const closing = rule.type === 'missing_confirmation' ? 'Please reply to this email to confirm, or tell us what differs.'
      : rule.type === 'quantity_discrepancy' ? 'Please confirm what you will deliver for each line, and when any remaining quantity will ship.'
      : rule.type === 'delivery_delay' ? 'Please confirm the delivery date, and whether any part can ship sooner.'
      : 'Please confirm the unit price for each line. The store will tell you whether it accepts the change.'
    subject = `Purchase order ${po.po_number}: ${rule.type === 'missing_confirmation' ? 'please confirm' : rule.type === 'quantity_discrepancy' ? 'quantities' : rule.type === 'delivery_delay' ? 'delivery date' : 'unit prices'}`
    body = [hello, '', intro, para, '', ...lineList(po, rule), '', closing]
  } else if (kind === 'clarify') {
    subject = f.previous ? (/^re:/i.test(f.previous.subject) ? f.previous.subject : `Re: ${f.previous.subject}`) : `Purchase order ${po.po_number}`
    body = [hello, '', `Thank you for your reply about purchase order ${clean(po.po_number, 64)}. We could not tell from it:`, ...(f.reasons ?? []).slice(0, 6).map(r => `- ${clean(r, 200)}`), '', ...lineList(po, rule), '', ask]
  } else {
    subject = f.previous ? (/^re:/i.test(f.previous.subject) ? f.previous.subject : `Re: ${f.previous.subject}`) : `Purchase order ${po.po_number}`
    body = [hello, '', `Following up on our message${f.previous?.sentAt ? ` of ${f.previous.sentAt.slice(0, 10)}` : ''} about purchase order ${clean(po.po_number, 64)}.`, ask, '', 'If you have already replied, please ignore this message.']
  }
  body.push('', `This message was prepared by the store's Deploi agent "${clean(f.agentName, 80)}".`)
  const dedupeKey = `supplier_exception:${f.caseId}:${kind}${kind === 'clarify' ? `:${f.replyId}` : ''}`
  return { taskKey: COORDINATOR_TASK, dedupeKey, to: [po.supplier_email.toLowerCase()], cc: [], inReplyTo: kind === 'request' ? null : f.previous?.internetMessageId ?? null,
    meta: { case_id: f.caseId, po_id: po.id, po_number: po.po_number, kind, exception: rule.type }, content: { subject: clean(subject, 180), bodyText: body.join('\n'), attachments: [] } }
}

type LinkedMsg = { id: string; status: string; status_reason: string | null; dedupe_key: string; internet_message_id: string; accepted_at: string | null; created_at: string; subject: string | null; meta: Record<string, unknown> }
async function caseMessages(db: Db, caseId: string): Promise<LinkedMsg[]> {
  return db.query<LinkedMsg>(`select m.id, m.status, m.status_reason, m.dedupe_key, m.internet_message_id, m.accepted_at, m.created_at, null as subject, m.meta from case_links l join email_messages m on m.id::text = l.ref_id
    where l.case_id = $1 and l.ref_type = 'email_message' and m.task_key = 'supplier_exception' order by m.created_at`, [caseId])
}

/**
 * Create one message for a case through the email engine and move the case by what the engine decided:
 * draft / awaiting approval -> awaiting_approval; queued (standing authorization) -> executing.
 * Refuses (case blocked, nothing drafted) when the PO's supplier is outside the agent's recipient rules.
 */
async function draftFor(co: Coordinator, c: CaseRow, kind: MsgKind, extra: { reasons?: string[]; replyId?: string; now: Date; actor: string }): Promise<{ messageId: string | null; status: string | null }> {
  const rule = ruleOf(c)
  if (!rule) return { messageId: null, status: null }
  const po = await admin(db => loadPo(db, rule.poId, c.org_id))
  if (!po) return { messageId: null, status: null }
  const e = co.policy.email!
  const to = po.supplier_email.toLowerCase()
  if (!recipientAllowed(e, to)) {
    await admin(db => moveCase(db, c.id, 'blocked', { actor: extra.actor, reason: `${to} (the supplier on PO ${po.po_number}) is not an allowed recipient of this agent: add it to the agent and grant the change`, nextCheckAt: null,
      nextAction: `Add ${to} to the Supplier Coordinator's allowed recipients` }))
    return { messageId: null, status: null }
  }
  const msgs = await admin(db => caseMessages(db, c.id))
  const prev = [...msgs].reverse().find(m => m.status === 'accepted') ?? null
  let previous: { internetMessageId: string; subject: string; sentAt: string | null } | null = null
  if (prev) {
    const s = await admin(db => db.one<{ key_id: string; content_ciphertext: string }>('select key_id, content_ciphertext from email_messages where id = $1', [prev.id]))
    const { decryptContent } = await import('../email/content')
    let subject = `Purchase order ${po.po_number}`
    try { subject = decryptContent(prev.id, s!.key_id, s!.content_ciphertext).subject } catch { /* keep the plain subject */ }
    previous = { internetMessageId: prev.internet_message_id, subject, sentAt: prev.accepted_at }
  }
  const d = supplierMessage(kind, { caseId: c.id, po, rule, agentName: co.name, storeName: co.storeName, reasons: extra.reasons, replyId: extra.replyId, previous })
  const created = await createAgentMessages({ agentId: co.agentId, runId: null, drafts: [d], actor: `agent:${co.name}`, now: extra.now })
  const m = created.created[0]
  if (!m) return { messageId: null, status: null } // the same message already exists (dedupe)
  await admin(async db => {
    await linkRecord(db, c.id, { type: 'email_message', id: m.id, label: `${kind === 'request' ? 'Message' : kind === 'clarify' ? 'Clarification' : 'Follow-up'} to ${to}` }, `agent:${co.name}`)
    if (m.status === 'queued') await moveCase(db, c.id, 'executing', { actor: `agent:${co.name}`, reason: `Sending the ${kind === 'request' ? 'message' : kind} to ${to} under the standing authorization`, approvalRequired: false, nextCheckAt: null, ref: { type: 'email_message', id: m.id } })
    else await moveCase(db, c.id, 'awaiting_approval', { actor: `agent:${co.name}`, approvalRequired: true, nextCheckAt: null, ref: { type: 'email_message', id: m.id },
      reason: m.status === 'draft' ? `Drafted the ${kind === 'request' ? 'message' : kind} to ${to}: this agent only drafts, so send it yourself or grant sending` : `The ${kind === 'request' ? 'message' : kind} to ${to} is waiting for your approval of its exact content`,
      nextAction: m.status === 'draft' ? 'Read the draft and send it yourself, or let the agent send after your approval' : 'Approve or edit the message' })
  })
  return { messageId: m.id, status: m.status }
}

/** Bring cases up to date with their messages: a sent message is an action (never a resolution) and the case waits for the supplier. */
export async function syncCaseMessages(orgId: string, now = new Date()): Promise<number> {
  return admin(async db => {
    const cases = await db.query<CaseRow>(`select * from cases where org_id = $1 and kind = $2 and status not in ('resolved','cancelled')`, [orgId, SUPPLIER_EXCEPTION_KIND])
    let moved = 0
    for (const c of cases) {
      const msgs = await caseMessages(db, c.id)
      if (!msgs.length) continue
      const recorded = new Set((await db.query<{ ref_id: string }>(`select ref_id from case_events where case_id = $1 and type = 'action' and ref_type = 'email_message'`, [c.id])).map(r => r.ref_id))
      const pendingOptions = await db.one<{ n: number }>(`select count(*)::int as n from purchase_order_resolutions where case_id = $1 and status = 'proposed'`, [c.id])
      for (const m of msgs.filter(x => x.status === 'accepted' && !recorded.has(x.id))) {
        await recordAction(db, c.id, { actor: 'system:supplier-coordinator', summary: `Sent the ${String(m.meta.kind ?? 'message')} about PO ${String(m.meta.po_number ?? '')} to the supplier (accepted by the email provider)`, ref: { type: 'email_message', id: m.id } })
        if (!pendingOptions?.n && ['detected', 'investigating', 'awaiting_approval', 'executing', 'blocked'].includes(c.status)) {
          const sent = m.accepted_at ? new Date(m.accepted_at) : now
          await moveCase(db, c.id, 'waiting_external', { actor: 'system:supplier-coordinator', reason: 'Waiting for the supplier to reply', approvalRequired: false,
            nextCheckAt: addDays(sent, FOLLOWUP_DAYS), nextAction: `If there is no reply by ${day(addDays(sent, FOLLOWUP_DAYS))}, one follow-up in the same thread`, ref: { type: 'email_message', id: m.id } })
          moved++
        }
      }
      const last = msgs[msgs.length - 1]
      const fresh = (await db.one<CaseRow>('select * from cases where id = $1', [c.id]))!
      if (['cancelled', 'failed'].includes(last.status) && ['awaiting_approval', 'executing'].includes(fresh.status) && !pendingOptions?.n) {
        await moveCase(db, c.id, 'blocked', { actor: 'system:supplier-coordinator', reason: `The message to the supplier was not sent: ${last.status_reason ?? last.status}`, nextCheckAt: null, approvalRequired: false,
          nextAction: 'Decide whether to write to the supplier yourself' })
        moved++
      }
    }
    return moved
  })
}

// ---------------------------------------------------------------- replies

export type ResolutionChange = { entity: 'purchase_order' | 'purchase_order_line'; id: string; sku?: string; field: string; from: unknown; to: unknown }
export type ResolutionOption = { kind: 'record_confirmation' | 'accept_new_date' | 'accept_partial_reorder' | 'accept_price_change' | 'cancel_line'; summary: string; change: { changes: ResolutionChange[]; reorder?: { poNumber: string; lines: { sku: string; qty: number; unitPrice: number }[] } } }
const PO_FIELDS = ['expected_at', 'confirmed_expected_at']
const LINE_FIELDS = ['qty_ordered', 'qty_confirmed', 'unit_price_ordered', 'unit_price_confirmed', 'cancelled']

/**
 * Resolution options from a clear reply. Each lists the exact PO field changes it makes (from -> to); values come
 * only from the PO and the numbers the reply states for SKUs on the PO. Empty when nothing can be offered.
 */
export function buildOptions(parsed: ParsedReply, po: PurchaseOrder, rule: ExceptionRule, reorderNumber: string): ResolutionOption[] {
  const open = openLines(po)
  const byS = new Map(open.map(l => [l.sku.toLowerCase(), l]))
  const confirmedAll = parsed.keywords.includes('confirmed')
  // what the supplier reported, recorded with any option the owner approves
  const reported: ResolutionChange[] = []
  for (const l of open) {
    const r = parsed.lines.find(x => x.sku.toLowerCase() === l.sku.toLowerCase())
    const q = r?.qty ?? (r?.status === 'unavailable' ? 0 : null) ?? (confirmedAll && l.qty_confirmed === null ? l.qty_ordered : null)
    if (q !== null && q !== l.qty_confirmed) reported.push({ entity: 'purchase_order_line', id: l.id, sku: l.sku, field: 'qty_confirmed', from: l.qty_confirmed, to: q })
    const p = r?.price ?? (confirmedAll && l.unit_price_confirmed === null && rule.type !== 'price_change' ? l.unit_price_ordered : null)
    if (p !== null && p !== l.unit_price_confirmed) reported.push({ entity: 'purchase_order_line', id: l.id, sku: l.sku, field: 'unit_price_confirmed', from: l.unit_price_confirmed, to: p })
  }
  const date = parsed.date
  if (date && date !== po.confirmed_expected_at) reported.push({ entity: 'purchase_order', id: po.id, field: 'confirmed_expected_at', from: po.confirmed_expected_at, to: date })
  const options: ResolutionOption[] = []
  const with_ = (extra: ResolutionChange[]) => [...reported.filter(r => !extra.some(e => e.id === r.id && e.field === r.field)), ...extra]

  if (date && (!po.expected_at || date > po.expected_at)) {
    options.push({ kind: 'accept_new_date', summary: `Accept the supplier's delivery date ${date}${po.expected_at ? ` (the order said ${po.expected_at})` : ''}; Deploi then watches for the goods and escalates if the date passes`,
      change: { changes: with_([{ entity: 'purchase_order', id: po.id, field: 'expected_at', from: po.expected_at, to: date }]) } })
  }
  // short lines: a stated quantity below what is still expected, or the remainder of a partial receipt the supplier cannot ship
  const short: { l: (typeof open)[number]; qty: number }[] = []
  const none: (typeof open)[number][] = []
  for (const r of parsed.lines) {
    const l = byS.get(r.sku.toLowerCase())
    if (!l) continue
    if (r.qty !== null && r.qty > 0 && r.qty < l.qty_ordered) short.push({ l, qty: Math.max(r.qty, l.qty_received) })
    else if ((r.qty === 0 || r.status === 'unavailable' || (r.status === 'backorder' && r.qty === null && !r.date)) && l.qty_received > 0 && l.qty_received < l.qty_ordered) short.push({ l, qty: l.qty_received })
    else if (r.qty === 0 || r.status === 'unavailable') none.push(l)
  }
  if (short.length) {
    const reorder = short.map(s => ({ sku: s.l.sku, qty: s.l.qty_ordered - s.qty, unitPrice: s.l.unit_price_ordered }))
    options.push({ kind: 'accept_partial_reorder', summary: `Accept ${short.map(s => `${s.l.sku} × ${s.qty}`).join(', ')} on PO ${po.po_number} and put the rest (${reorder.map(r => `${r.sku} × ${r.qty}`).join(', ')}) on a new draft PO ${reorderNumber} for you to send`,
      change: { changes: with_(short.flatMap(s => [{ entity: 'purchase_order_line' as const, id: s.l.id, sku: s.l.sku, field: 'qty_ordered', from: s.l.qty_ordered, to: s.qty }, { entity: 'purchase_order_line' as const, id: s.l.id, sku: s.l.sku, field: 'qty_confirmed', from: s.l.qty_confirmed, to: s.qty }])),
        reorder: { poNumber: reorderNumber, lines: reorder } } })
  }
  const priced = parsed.lines.map(r => ({ r, l: byS.get(r.sku.toLowerCase()) })).filter((x): x is { r: (typeof parsed.lines)[number]; l: (typeof open)[number] } => Boolean(x.l) && x.r.price !== null && priceDiffers(x.l!.unit_price_ordered, x.r.price!, rule.priceTolerancePct))
  if (priced.length) {
    options.push({ kind: 'accept_price_change', summary: `Accept the new unit price${priced.length === 1 ? '' : 's'}: ${priced.map(x => `${x.l.sku} ${money(x.l.unit_price_ordered, po.currency)} -> ${money(x.r.price!, po.currency)}`).join(', ')}`,
      change: { changes: with_(priced.map(x => ({ entity: 'purchase_order_line' as const, id: x.l.id, sku: x.l.sku, field: 'unit_price_ordered', from: x.l.unit_price_ordered, to: x.r.price }))) } })
  }
  // price lines from the PO itself (a price case where the reply only confirms)
  const cancellable = [...new Map([...none, ...short.map(s => s.l), ...priced.map(x => x.l),
    ...(rule.type === 'price_change' ? open.filter(l => l.unit_price_confirmed !== null && priceDiffers(l.unit_price_ordered, l.unit_price_confirmed, rule.priceTolerancePct)) : [])]
    .filter(l => l.qty_received === 0).map(l => [l.id, l])).values()]
  if (cancellable.length) {
    options.push({ kind: 'cancel_line', summary: `Cancel ${cancellable.length === 1 ? 'the line' : 'the lines'} ${cancellable.map(l => l.sku).join(', ')} on PO ${po.po_number}`,
      change: { changes: with_(cancellable.map(l => ({ entity: 'purchase_order_line' as const, id: l.id, sku: l.sku, field: 'cancelled', from: false, to: true }))) } })
  }
  const allStated = open.every(l => reported.some(r => r.id === l.id && r.field === 'qty_confirmed') || l.qty_confirmed !== null)
  if (!options.length && reported.length && (confirmedAll || allStated)) {
    options.push({ kind: 'record_confirmation', summary: `Record the supplier's confirmation on PO ${po.po_number}: ${reported.filter(r => r.field === 'qty_confirmed').map(r => `${r.sku} × ${r.to}`).join(', ') || 'as ordered'}${date ? `, delivery ${date}` : ''}`,
      change: { changes: reported } })
  }
  // an option must change something on this PO
  return options.filter(o => o.change.changes.length || o.change.reorder)
}

const optionHash = (caseId: string, poId: string, o: ResolutionOption) => createHash('sha256').update(canonicalJson({ caseId, poId, kind: o.kind, change: o.change })).digest('hex')

type InboundRow = { id: string; org_id: string; from_address: string; received_at: string; key_id: string; content_ciphertext: string; attachments: ReplyAttachment[] | null; thread_message_id: string; case_id: string }

/**
 * Handle new supplier replies on this organization's PO threads: each inbound email once (and the same words twice
 * once). `attachmentContent` supplies text of CSV/plain-text attachments when the mail pipeline has it (by inbound id);
 * otherwise attachments are metadata only.
 */
export async function processSupplierReplies(orgId: string, opts: { now?: Date; attachmentContent?: Record<string, Record<string, string>> } = {}): Promise<{ handled: number; clear: number; ambiguous: number; ignored: number }> {
  const now = opts.now ?? new Date()
  const out = { handled: 0, clear: 0, ambiguous: 0, ignored: 0 }
  if (await admin(db => orgStopReason(db, orgId))) return out
  const rows = await admin(db => db.query<InboundRow>(
    `select i.id, i.org_id, i.from_address, i.received_at, i.key_id, i.content_ciphertext, i.attachments, i.thread_message_id, l.case_id
     from email_inbound i join email_messages m on m.id = i.thread_message_id and m.task_key = 'supplier_exception' and m.org_id = i.org_id
     join case_links l on l.ref_type = 'email_message' and l.ref_id = m.id::text and l.org_id = i.org_id
     where i.org_id = $1 and i.status = 'accepted' and i.classification = 'reply' and not i.auto_reply and i.key_id <> 'pending'
       and not exists (select 1 from supplier_replies r where r.inbound_id = i.id)
     order by i.received_at, i.id limit 100`, [orgId]))
  for (const r of rows) {
    out.handled++
    const res = await handleReply(r, now, opts.attachmentContent?.[r.id] ?? {})
    out[res]++
  }
  return out
}

async function handleReply(r: InboundRow, now: Date, attachmentText: Record<string, string>): Promise<'clear' | 'ambiguous' | 'ignored'> {
  const c = (await admin(db => db.one<CaseRow>('select * from cases where id = $1', [r.case_id])))!
  const rule = ruleOf(c)
  const po = rule ? await admin(db => loadPo(db, rule.poId, c.org_id)) : null
  const ignore = (reason: string, hash = createHash('sha256').update(`ignored:${r.id}`).digest('hex')) => admin(async db => {
    await db.query(`insert into supplier_replies (org_id, case_id, po_id, inbound_id, content_hash, outcome, parsed, received_at) values ($1,$2,$3,$4,$5,'ignored',$6,$7) on conflict (inbound_id) do nothing`,
      [c.org_id, c.id, rule?.poId ?? po?.id, r.id, hash, JSON.stringify({ reason }), r.received_at])
    return 'ignored' as const
  })
  if (!rule || !po) return 'ignored' // the case is blocked by its checker; nothing to read the reply against
  if (TERMINAL.includes(c.status)) return ignore(`the case was already ${c.status}`)
  if (r.from_address.toLowerCase() !== po.supplier_email.toLowerCase()) return ignore(`from ${r.from_address}, not the supplier on PO ${po.po_number}: kept in the mailbox for you to read`)
  let content: { subject?: string; text?: string }
  try { content = JSON.parse(decryptSecret(r.key_id, r.content_ciphertext, `email-inbound:${r.id}`)) } catch { return ignore('the reply could not be read') }
  const attachments: ReplyAttachment[] = (Array.isArray(r.attachments) ? r.attachments : []).map(a => ({ filename: String(a.filename ?? 'attachment'), contentType: String(a.contentType ?? 'application/octet-stream'), size: typeof a.size === 'number' ? a.size : null, content: attachmentText[String(a.filename ?? '')] ?? null }))
  const parsed = parseSupplierReply({ text: String(content.text ?? ''), attachments, receivedAt: new Date(r.received_at), po: { poNumber: po.po_number, expectedAt: po.expected_at, caseType: rule.type,
    lines: po.lines.map(l => ({ sku: l.sku, qtyOrdered: l.qty_ordered, priceOrdered: l.unit_price_ordered, cancelled: l.cancelled })) } })
  const dup = await admin(db => db.one<{ id: string }>(`select id from supplier_replies where case_id = $1 and content_hash = $2 and outcome <> 'ignored'`, [c.id, parsed.contentHash]))
  if (dup) return ignore('the same reply was already handled', parsed.contentHash)
  const reorderNumber = await admin(async db => `${po.po_number.slice(0, 58)}-R${1 + Number((await db.one<{ n: number }>('select count(*)::int as n from purchase_orders where parent_po_id = $1', [po.id]))!.n)}`)
  let options = parsed.outcome === 'clear' ? buildOptions(parsed, po, rule, reorderNumber) : []
  if (parsed.outcome === 'clear' && !options.length) parsed.reasons.push('the reply does not say anything that would change the purchase order')
  const outcome = parsed.outcome === 'clear' && options.length ? 'clear' : 'ambiguous'
  if (outcome === 'ambiguous') options = []
  const replyId = await admin(async db => {
    const row = await db.one<{ id: string }>(`insert into supplier_replies (org_id, case_id, po_id, inbound_id, content_hash, outcome, parsed, received_at) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (inbound_id) do nothing returning id`,
      [c.org_id, c.id, po.id, r.id, parsed.contentHash, outcome, JSON.stringify({ ...parsed, outcome }), r.received_at])
    if (!row) return null
    const said = [parsed.date ? `delivery ${parsed.date}` : null, ...parsed.lines.map(l => `${l.sku}: ${[l.qty !== null ? `qty ${l.qty}` : null, l.price !== null ? `price ${l.price}` : null, l.status].filter(Boolean).join(', ')}`), ...parsed.keywords].filter(Boolean).join('; ')
    await addEvidence(db, c.id, { label: `Supplier replied about PO ${po.po_number}${said ? `: ${said}` : ''}`.slice(0, 300), source: 'supplier_reply', observedAt: new Date(r.received_at).toISOString(), ref: { type: 'email_inbound', id: r.id },
      detail: { outcome, reasons: parsed.reasons, attachments: parsed.attachments, ignored: parsed.ignored, read_as: 'data' } }, 'system:supplier-coordinator')
    await linkRecord(db, c.id, { type: 'email_inbound', id: r.id, label: 'Supplier reply' }, 'system:supplier-coordinator')
    // a follow-up or clarification that has not gone out is no longer needed
    for (const m of await caseMessages(db, c.id)) if (OPEN_DRAFT.includes(m.status))
      await db.query(`update email_messages set status = 'cancelled', status_reason = 'the supplier replied; this message is not needed', next_attempt_at = null where id = $1 and status = any($2::text[])`, [m.id, OPEN_DRAFT])
    // earlier options built from an older reply are replaced by the ones from this reply
    await db.query(`update purchase_order_resolutions set status = 'superseded', status_reason = 'a newer supplier reply replaced these options' where case_id = $1 and status = 'proposed'`, [c.id])
    return row.id
  })
  if (!replyId) return 'ignored'
  if (outcome === 'clear') {
    await admin(async db => {
      for (const o of options) {
        await db.query(`insert into purchase_order_resolutions (org_id, case_id, po_id, kind, summary, change, change_hash, reply_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [c.org_id, c.id, po.id, o.kind, o.summary.slice(0, 1000), JSON.stringify(o.change), optionHash(c.id, po.id, o), replyId])
      }
      await moveCase(db, c.id, 'proposed', { actor: 'system:supplier-coordinator', reason: `The supplier replied; ${options.length} option${options.length === 1 ? '' : 's'} to resolve it`, ref: { type: 'email_inbound', id: r.id } })
      await moveCase(db, c.id, 'awaiting_approval', { actor: 'system:supplier-coordinator', reason: `Choose one option: each changes PO ${po.po_number}, so it needs your approval`, approvalRequired: true, nextCheckAt: null,
        nextAction: options.map(o => o.summary).join(' | ').slice(0, 1000) })
    })
    return 'clear'
  }
  await admin(db => moveCase(db, c.id, 'investigating', { actor: 'system:supplier-coordinator', reason: `The supplier's reply is not clear: ${parsed.reasons.join('; ')}`.slice(0, 1000), nextCheckAt: null, ref: { type: 'email_inbound', id: r.id },
    nextAction: 'Ask the supplier to clarify' }))
  const fresh = (await admin(db => db.one<CaseRow>('select * from cases where id = $1', [c.id])))!
  const co = fresh.agent_kind === 'engine' && fresh.agent_ref ? await admin(db => loadCoordinator(db, fresh.agent_ref!)) : null
  if (co && !(await admin(db => orgStopReason(db, co.orgId)))) {
    await draftFor(co, fresh, 'clarify', { reasons: parsed.reasons, replyId, now, actor: `agent:${co.name}` })
    await processQueue({ agentId: co.agentId, actor: `agent:${co.name}`, now })
    await syncCaseMessages(c.org_id, now)
  }
  return 'ambiguous'
}

// ---------------------------------------------------------------- owner decisions on options

export type ResolutionRow = { id: string; org_id: string; case_id: string; po_id: string; kind: ResolutionOption['kind']; summary: string; change: ResolutionOption['change']; change_hash: string; reply_id: string | null; status: string; status_reason: string | null; created_at: string }

export async function listResolutions(db: Db, orgId: string, opts: { caseId?: string; status?: string } = {}): Promise<ResolutionRow[]> {
  return db.query<ResolutionRow>(`select id, org_id, case_id, po_id, kind, summary, change, change_hash, reply_id, status, status_reason, created_at from purchase_order_resolutions
    where org_id = $1 and ($2::uuid is null or case_id = $2) and ($3::text is null or status = $3) order by created_at, id`, [orgId, opts.caseId ?? null, opts.status ?? null])
}

const sameValue = (a: unknown, b: unknown) => (a === null || a === undefined ? b === null || b === undefined : typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : String(a) === String(b))

/**
 * The owner approves (or rejects) one resolution option. Approval is bound to the option's change hash; the PO
 * is updated only if every field still has the value the option was built on (otherwise it is stale). Applying
 * is an action: the case then goes to verifying and resolves only if the fresh PO record shows the agreed state.
 */
export async function decideResolution(actor: Actor, resolutionId: string, version: string, decision: 'approve' | 'reject', opts: { now?: Date } = {}): Promise<{ status: string; caseStatus: CaseStatus; reason?: string }> {
  const now = opts.now ?? new Date()
  const visible = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from purchase_order_resolutions where id = $1', [resolutionId]))
  if (!visible) throw new EngineError('not_found', 'option not found')
  assertMerchant(actor, visible.org_id)
  const caseId = await admin(async db => {
    const stop = await orgStopReason(db, visible.org_id)
    if (stop) throw new EngineError('agent_inactive', `${stop}; purchase orders are not changed while agents are stopped`)
    const o = await db.one<ResolutionRow>('select id, org_id, case_id, po_id, kind, summary, change, change_hash, reply_id, status, status_reason, created_at from purchase_order_resolutions where id = $1 for update', [resolutionId])
    if (!o) throw new EngineError('not_found', 'option not found')
    if (o.status !== 'proposed') throw new EngineError('not_pending', `this option is ${o.status}`)
    if (o.change_hash !== version) throw new EngineError('hash_mismatch', 'this option changed after you opened it; review it again')
    const c = (await db.one<CaseRow>('select * from cases where id = $1 for update', [o.case_id]))!
    if (TERMINAL.includes(c.status)) throw new EngineError('not_pending', `the case is ${c.status}`)
    if (decision === 'reject') {
      await db.query(`update purchase_order_resolutions set status = 'rejected', decided_by = $2, decided_at = now() where id = $1`, [o.id, actor.label])
      await audit(db, { orgId: o.org_id, entityType: 'purchase_order', entityId: o.po_id, event: 'purchase_order.option_rejected', actor: actor.label, detail: { case_id: o.case_id, option: o.kind, change_hash: o.change_hash } })
      const left = await db.one<{ n: number }>(`select count(*)::int as n from purchase_order_resolutions where case_id = $1 and status = 'proposed'`, [o.case_id])
      if (!left?.n) await moveCase(db, o.case_id, 'investigating', { actor: actor.label, reason: 'You rejected the options from the supplier\'s reply', approvalRequired: false, nextAction: 'Agree the next step with the supplier, or close the case' })
      return o.case_id
    }
    // apply: every field must still hold the value the option was built on
    await db.query('select id from purchase_orders where id = $1 for update', [o.po_id])
    const po = (await loadPo(db, o.po_id, o.org_id))!
    for (const ch of o.change.changes) {
      const ok = ch.entity === 'purchase_order' ? PO_FIELDS.includes(ch.field) && ch.id === po.id : LINE_FIELDS.includes(ch.field) && po.lines.some(l => l.id === ch.id)
      if (!ok) throw new EngineError('forbidden', 'the option touches something it may not')
      const current = ch.entity === 'purchase_order' ? (po as unknown as Record<string, unknown>)[ch.field] : (po.lines.find(l => l.id === ch.id) as unknown as Record<string, unknown>)[ch.field]
      if (!sameValue(current, ch.from)) {
        await db.query(`update purchase_order_resolutions set status = 'stale', status_reason = $2 where id = $1`, [o.id, `PO ${po.po_number} changed since this option was prepared (${ch.field})`])
        throw new EngineError('rule_changed', `PO ${po.po_number} changed since this option was prepared; nothing was changed`)
      }
    }
    await moveCase(db, o.case_id, 'executing', { actor: actor.label, reason: `You approved: ${o.summary}`.slice(0, 1000), approvalRequired: false, nextCheckAt: null })
    for (const ch of o.change.changes) {
      if (ch.entity === 'purchase_order') {
        const v = ch.to === null ? null : isoDate(String(ch.to))
        if (ch.to !== null && !v) throw new EngineError('invalid_input', 'not a date')
        await db.query(`update purchase_orders set ${ch.field === 'expected_at' ? 'expected_at' : 'confirmed_expected_at'} = $2::date where id = $1`, [po.id, v])
      } else {
        const col = LINE_FIELDS.find(f => f === ch.field)!
        await db.query(`update purchase_order_lines set ${col} = $2 where id = $1 and po_id = $3`, [ch.id, ch.to, po.id])
      }
    }
    let reorderId: string | null = null
    if (o.change.reorder?.lines.length) {
      const taken = await db.one('select id from purchase_orders where org_id = $1 and po_number = $2', [o.org_id, o.change.reorder.poNumber])
      if (taken) throw new EngineError('rule_changed', `PO number ${o.change.reorder.poNumber} is already used; nothing was changed`)
      const r = (await db.one<{ id: string }>(`insert into purchase_orders (org_id, connection_id, po_number, supplier_name, supplier_email, status, ordered_at, currency, source, parent_po_id, created_by, subtotal)
        values ($1,$2,$3,$4,$5,'draft',$6::date,$7,'manual',$8,$9,$10) returning id`,
        [o.org_id, po.connection_id, o.change.reorder.poNumber, po.supplier_name, po.supplier_email, day(now), po.currency, po.id, actor.label, o.change.reorder.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0).toFixed(4)]))!
      reorderId = r.id
      let n = 0
      for (const l of o.change.reorder.lines) {
        const src = po.lines.find(x => x.sku === l.sku)
        await db.query(`insert into purchase_order_lines (po_id, org_id, line_no, sku, description, variant_ref, match_status, qty_ordered, unit_price_ordered, unit_price_original) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
          [r.id, o.org_id, ++n, l.sku, src?.description ?? null, src?.variant_ref ?? null, src?.match_status ?? 'unmatched', l.qty, l.unitPrice])
      }
    }
    await refreshStatus(db, po.id)
    await db.query(`update purchase_order_resolutions set status = 'applied', decided_by = $2, decided_at = now(), applied_at = now() where id = $1`, [o.id, actor.label])
    await db.query(`update purchase_order_resolutions set status = 'superseded', status_reason = 'another option was approved' where case_id = $1 and status = 'proposed'`, [o.case_id])
    await audit(db, { orgId: o.org_id, connectionId: po.connection_id, entityType: 'purchase_order', entityId: po.id, event: 'purchase_order.updated', actor: actor.label,
      detail: { case_id: o.case_id, option: o.kind, change_hash: o.change_hash, changes: o.change.changes, reorder_po_id: reorderId } })
    await recordAction(db, o.case_id, { actor: actor.label, summary: `Updated PO ${po.po_number}: ${o.summary}`.slice(0, 1000), ref: { type: 'purchase_order', id: po.id }, detail: { option_id: o.id, changes: o.change.changes.length, reorder_po_id: reorderId } })
    if (reorderId) await linkRecord(db, o.case_id, { type: 'purchase_order', id: reorderId, label: `Draft PO ${o.change.reorder!.poNumber}` }, actor.label)
    return o.case_id
  })
  if (decision === 'reject') return { status: 'rejected', caseStatus: (await admin(db => db.one<{ status: CaseStatus }>('select status from cases where id = $1', [caseId])))!.status }
  const v = await verifyCase(caseId, now, actor.label)
  return { status: 'applied', caseStatus: v.status, reason: v.reason }
}

/**
 * Verify a case against a fresh read of its PO: resolve with that evidence when the record shows the agreed state;
 * otherwise wait for the goods (monitoring the date) or go back to investigating with what is still different.
 */
export async function verifyCase(caseId: string, now: Date, actor = 'system:supplier-coordinator'): Promise<{ status: CaseStatus; reason?: string }> {
  return admin(async db => {
    const c = (await db.one<CaseRow>('select * from cases where id = $1 for update', [caseId]))!
    if (TERMINAL.includes(c.status)) return { status: c.status }
    const rule = ruleOf(c)
    const po = rule ? await loadPo(db, rule.poId, c.org_id) : null
    if (!rule || !po) {
      const b = await moveCase(db, c.id, 'blocked', { actor, reason: 'the purchase order is no longer in Deploi', nextCheckAt: null })
      return { status: b.status }
    }
    if (c.status !== 'verifying') await moveCase(db, c.id, 'verifying', { actor, reason: `Checking PO ${po.po_number}` })
    const r = ruleMet(rule, po)
    if (r.met) {
      const done = await resolveCase(db, c.id, { actor, summary: `PO ${po.po_number} shows the agreed state: ${r.observed}`.slice(0, 1000), verifiedBy: `purchase order record ${po.po_number}`,
        evidence: [{ label: r.observed.slice(0, 300), source: 'purchase_order', observedAt: now.toISOString(), ref: { type: 'purchase_order', id: po.id }, detail: { status: po.status, updated_at: po.updated_at } }] })
      return { status: done.status }
    }
    const applied = await db.one<{ n: number }>(`select count(*)::int as n from purchase_order_resolutions where case_id = $1 and status = 'applied'`, [c.id])
    const deadline = po.expected_at ? addDays(po.expected_at, GRACE_DAYS) : null
    if (applied?.n && (rule.requireReceipt || rule.type === 'delivery_delay' || openLines(po).some(l => l.qty_received > 0 && l.qty_received < l.qty_ordered))) {
      if (deadline && deadline.getTime() < now.getTime()) {
        const e = await moveCase(db, c.id, 'escalated', { actor, reason: `The agreed date ${po.expected_at} for PO ${po.po_number} passed and the goods are not recorded as received`, nextCheckAt: null,
          nextAction: 'Talk to the supplier: the agreed date was missed', evidence: [{ label: r.observed.slice(0, 300), source: 'purchase_order', observedAt: now.toISOString(), ref: { type: 'purchase_order', id: po.id } }] })
        return { status: e.status, reason: 'agreed date missed' }
      }
      const w = await moveCase(db, c.id, 'waiting_external', { actor, reason: `Waiting for the goods: PO ${po.po_number} ${po.expected_at ? `is due ${po.expected_at}` : 'has no date'} (${r.observed})`.slice(0, 1000),
        nextCheckAt: deadline && deadline > now ? deadline : addDays(now, 1), nextAction: 'Record what you receive; the case resolves when the PO shows everything received' })
      return { status: w.status }
    }
    const i = await moveCase(db, c.id, 'investigating', { actor, reason: `PO ${po.po_number} does not show the agreed state yet: ${r.observed}`.slice(0, 1000), nextCheckAt: null, nextAction: 'Agree the remaining difference with the supplier' })
    return { status: i.status }
  })
}

// ---------------------------------------------------------------- organization stop

/** An organization stop halts the flow: pending messages and options are withdrawn, open cases are blocked. */
export async function haltForStop(orgId: string, reason: string): Promise<number> {
  return admin(async db => {
    const cases = await db.query<CaseRow>(`select * from cases where org_id = $1 and kind = $2 and status not in ('resolved','cancelled','blocked')`, [orgId, SUPPLIER_EXCEPTION_KIND])
    for (const c of cases) {
      for (const m of await caseMessages(db, c.id)) if (OPEN_DRAFT.includes(m.status))
        await db.query(`update email_messages set status = 'cancelled', status_reason = $2, next_attempt_at = null where id = $1 and status = any($3::text[])`, [m.id, `not sent: ${reason}`, OPEN_DRAFT])
      await db.query(`update purchase_order_resolutions set status = 'withdrawn', status_reason = $2 where case_id = $1 and status = 'proposed'`, [c.id, reason])
      await moveCase(db, c.id, 'blocked', { actor: 'system:supplier-coordinator', reason, nextCheckAt: null, approvalRequired: false, nextAction: 'Turn the organization stop off, then resume the Supplier Coordinator' })
    }
    return cases.length
  })
}

// ---------------------------------------------------------------- the agent's step and the case checker

export type CoordinatorCounts = { opened: number; redetected: number; drafted: number; awaitingYou: number; sent: number; replies: number; resolved: number; escalated: number; blocked: number; stopped?: string }

/** One Supplier Coordinator pass: detect, adopt cases, handle replies, prepare messages, send what its tier allows, verify. */
export async function runSupplierCoordinator(agentId: string, opts: { now?: Date; actor?: string } = {}): Promise<CoordinatorCounts> {
  const now = opts.now ?? new Date()
  const counts: CoordinatorCounts = { opened: 0, redetected: 0, drafted: 0, awaitingYou: 0, sent: 0, replies: 0, resolved: 0, escalated: 0, blocked: 0 }
  const az = await admin(db => authorizeAgentAction(db, { agentId, action: { tool: 'run' }, now }))
  if (!az.ok) {
    if (az.code === 'org_stopped') {
      const org = await admin(db => db.one<{ org_id: string }>('select org_id from agents where id = $1', [agentId]))
      if (org) counts.blocked = await haltForStop(org.org_id, az.reason)
    }
    counts.stopped = az.reason
    return counts
  }
  const co = await admin(db => loadCoordinator(db, agentId))
  if (!co) return counts
  const actor = opts.actor ?? `agent:${co.name}`
  const o = await openSupplierExceptionCases(co.orgId, { now, actor })
  counts.opened = o.opened.length; counts.redetected = o.redetected.length
  // adopt unassigned cases (opened before the coordinator existed): ownership only, nothing granted
  const loose = await admin(db => db.query<{ id: string }>(`select id from cases where org_id = $1 and kind = $2 and agent_ref is null and status not in ('resolved','cancelled')`, [co.orgId, SUPPLIER_EXCEPTION_KIND]))
  for (const l of loose) await admin(db => handOffCase(db, l.id, { kind: 'engine', ref: agentId }, { actor, reason: 'Supplier exceptions go to the Supplier Coordinator' }))
  await syncCaseMessages(co.orgId, now)
  const rep = await processSupplierReplies(co.orgId, { now })
  counts.replies = rep.handled
  // a message for each new case of this agent
  const fresh = await admin(db => db.query<CaseRow>(`select c.* from cases c where c.org_id = $1 and c.kind = $2 and c.agent_kind = 'engine' and c.agent_ref = $3 and c.status = 'detected'
    and not exists (select 1 from case_links l where l.case_id = c.id and l.ref_type = 'email_message') order by c.opened_at`, [co.orgId, SUPPLIER_EXCEPTION_KIND, agentId]))
  for (const c of fresh) {
    // the PO may already show the agreed state (e.g. a re-import with the confirmation): verify instead of writing
    const rule = ruleOf(c)
    const po = rule ? await admin(db => loadPo(db, rule.poId, c.org_id)) : null
    if (rule && po && ruleMet(rule, po).met) { if ((await verifyCase(c.id, now, actor)).status === 'resolved') counts.resolved++; continue }
    const d = await draftFor(co, c, 'request', { now, actor })
    if (d.messageId) { counts.drafted++; if (d.status !== 'queued') counts.awaitingYou++ }
    else if ((await admin(db => db.one<{ status: string }>('select status from cases where id = $1', [c.id])))?.status === 'blocked') counts.blocked++
  }
  for (const r of await processQueue({ agentId, actor, now })) if (r.status === 'accepted') counts.sent++
  await syncCaseMessages(co.orgId, now)
  // re-verify open cases whose PO may have changed (a re-import, a receipt)
  const open = await admin(db => db.query<CaseRow>(`select * from cases where org_id = $1 and kind = $2 and status in ('waiting_external','verifying','investigating','detected') and agent_ref = $3`, [co.orgId, SUPPLIER_EXCEPTION_KIND, agentId]))
  for (const c of open) {
    const rule = ruleOf(c)
    const po = rule ? await admin(db => loadPo(db, rule.poId, c.org_id)) : null
    if (rule && po && ruleMet(rule, po).met) { if ((await verifyCase(c.id, now, actor)).status === 'resolved') counts.resolved++ }
  }
  return counts
}

/** After the PO changed (a receipt, a re-import): check its open cases now instead of at their next check. */
export async function recheckPo(orgId: string, poId: string, now = new Date()) {
  const cases = await admin(db => db.query<CaseRow>(`select c.* from case_links l join cases c on c.id = l.case_id where l.org_id = $1 and l.ref_type = 'purchase_order' and l.ref_id = $2 and c.kind = $3 and c.status not in ('resolved','cancelled')`, [orgId, poId, SUPPLIER_EXCEPTION_KIND]))
  const out: { caseId: string; status: CaseStatus }[] = []
  for (const c of cases) {
    const rule = ruleOf(c)
    const po = rule ? await admin(db => loadPo(db, rule.poId, orgId)) : null
    if (!rule || !po) continue
    const applied = await admin(db => db.one<{ n: number }>(`select count(*)::int as n from purchase_order_resolutions where case_id = $1 and status = 'applied'`, [c.id]))
    if (ruleMet(rule, po).met || (applied?.n && c.status === 'waiting_external')) out.push({ caseId: c.id, status: (await verifyCase(c.id, now)).status })
  }
  return out
}

/**
 * The durable check for a supplier exception case (lib/cases: `case.check`). Looks at the world again: new replies,
 * the PO record, the date. Waiting for a reply: one follow-up, then escalate. Monitoring an agreed date: resolve on
 * receipt, escalate when the date passes.
 */
export async function checkSupplierCase(c0: CaseRow, now: Date): Promise<void> {
  const stop = await admin(db => orgStopReason(db, c0.org_id))
  if (stop) { await haltForStop(c0.org_id, stop); return }
  await processSupplierReplies(c0.org_id, { now })
  await syncCaseMessages(c0.org_id, now)
  const c = (await admin(db => db.one<CaseRow>('select * from cases where id = $1', [c0.id])))!
  if (TERMINAL.includes(c.status)) return
  const rule = ruleOf(c)
  const po = rule ? await admin(db => loadPo(db, rule.poId, c.org_id)) : null
  if (!rule || !po) { await admin(db => moveCase(db, c.id, 'blocked', { actor: 'system:supplier-coordinator', reason: 'the purchase order is no longer in Deploi', nextCheckAt: null })); return }
  if (ruleMet(rule, po).met) { await verifyCase(c.id, now); return }
  if (c.status !== 'waiting_external') return
  const applied = await admin(db => db.one<{ n: number }>(`select count(*)::int as n from purchase_order_resolutions where case_id = $1 and status = 'applied'`, [c.id]))
  if (applied?.n) { await verifyCase(c.id, now); return }
  // waiting for a reply
  const msgs = await admin(db => caseMessages(db, c.id))
  const followup = msgs.find(m => String(m.meta.kind) === 'followup')
  if (!followup) {
    const co = c.agent_kind === 'engine' && c.agent_ref ? await admin(db => loadCoordinator(db, c.agent_ref!)) : null
    const az = co ? await admin(db => authorizeAgentAction(db, { agentId: co.agentId, orgId: c.org_id, action: { tool: 'run' }, now })) : null
    if (co && az?.ok) {
      await draftFor(co, c, 'followup', { now, actor: `agent:${co.name}` })
      await processQueue({ agentId: co.agentId, actor: `agent:${co.name}`, now })
      await syncCaseMessages(c.org_id, now)
      const after = (await admin(db => db.one<CaseRow>('select * from cases where id = $1', [c.id])))!
      // the follow-up went out: the case keeps waiting, with one more interval before escalating
      if (after.status === 'waiting_external') await admin(db => moveCase(db, c.id, 'waiting_external', { actor: 'system:supplier-coordinator', reason: 'Followed up once; waiting for the supplier to reply', nextCheckAt: addDays(now, FOLLOWUP_DAYS) }))
      return
    }
  }
  await admin(db => moveCase(db, c.id, 'escalated', { actor: 'system:supplier-coordinator', reason: `No reply from ${po.supplier_email} about PO ${po.po_number}${followup ? ' after a follow-up' : ''}`, nextCheckAt: null,
    nextAction: 'Contact the supplier another way (phone), or decide what to do with the order' }))
}

registerCaseKind(SUPPLIER_EXCEPTION_KIND, checkSupplierCase)

export { EXCEPTION_LABEL }

/** After an import: open or re-detect cases for the POs that changed, and re-check cases whose PO now shows the agreed state. */
export async function afterPoImport(orgId: string, poIds: string[], actor: string, now = new Date()) {
  if (!poIds.length) return { opened: [] as string[], redetected: [] as string[], rechecked: [] as { caseId: string; status: CaseStatus }[] }
  const r = await openSupplierExceptionCases(orgId, { now, actor, poIds })
  const rechecked: { caseId: string; status: CaseStatus }[] = []
  for (const id of poIds) rechecked.push(...await recheckPo(orgId, id, now))
  return { ...r, rechecked }
}
