/**
 * Accounts Receivable agent (Deploi Office, kind `accounts_receivable`). Reads QuickBooks Online only and
 * carries each overdue invoice as one `invoice_overdue` case (lib/cases) to a verified outcome:
 *
 *   detected (an overdue invoice, read from QuickBooks)
 *     -> proposed (drafts only) | awaiting_approval (after approval) | executing (without asking)
 *     -> waiting_external (reminder sent; next check)
 *     -> verifying (the customer says it is paid)  -> resolved ONLY when a fresh QuickBooks read shows balance 0
 *     -> escalated (dispute, unclear reply, every reminder sent: over to the owner; reminders stop)
 *
 * Rules:
 *  - every number, date, name and address in a reminder is copied from a QuickBooks read; nothing is invented.
 *    Just before a reminder goes out the invoice is read again: paid, changed balance, changed billing
 *    address or changed due date cancels that reminder (a new one is prepared from the new read);
 *  - the only recipient is the invoice's own BillEmail (RecipientSource `invoice`, recomputed from the database
 *    at every gate). A reply is reduced to one category (and a promised date): its text never adds a recipient
 *    or changes what the agent may do;
 *  - sending goes through lib/office/actions.ts (the policy's email tier, approvals, the email engine);
 *  - a part payment keeps the case open with the new balance (evidence added, the next reminder says it);
 *  - Deploi never writes to QuickBooks.
 */
import { createHash } from 'node:crypto'
import { officeBlockReason } from '../integrations/blocking'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { admin, type Db } from '../db'
import { log } from '../log'
import { decryptSecret } from '../connectors/credentials'
import { EngineError } from '../engine/errors'
import { hasProduct } from '../products'
import { addEvidence, addNote, canTransition, handOffCase, openCase, recordAction, registerCaseKind, resolveCase, TERMINAL, TRANSITIONS, transitionCase,
  type CaseRow, type CaseStatus, type Evidence } from '../cases'
import { officeAudit } from './audit'
import { OfficeHttpError } from './http'
import { OfficeAuthError } from './credentials'
import { quickbooksFor } from './providers'
import { agentCtx, onOfficeActionSettled, proposeAction, registerEmailPrecheck, type AgentCtx, type EmailPayload, type OfficeActionRow } from './actions'
import { newText, type EmailDraft } from './content'
import { QBO_PAGE, type QboInvoice, type QuickBooksApi } from './quickbooks'
import type { OfficeConnectionRow } from './connections'
import type { OfficePolicy } from './policy'

export const CASE_KIND = 'invoice_overdue'
export const SOURCE_APP = 'quickbooks'
const VERIFIER = 'QuickBooks Online (fresh read)'
const MAX_PAGES = 10
type Counts = Record<string, number>
const inc = (c: Counts, k: string, n = 1) => { c[k] = (c[k] ?? 0) + n }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const cents = (n: number | string | null | undefined) => Math.round(Number(n ?? 0) * 100)
const DAY = 864e5

export type InvoiceStatus = 'open' | 'held' | 'disputed' | 'stopped' | 'exhausted' | 'paid' | 'closed'
export type InvoiceRow = {
  id: string; org_id: string; agent_id: string; connection_id: string; realm_id: string; qbo_invoice_id: string; case_id: string | null
  status: InvoiceStatus; status_reason: string | null; doc_number: string | null; customer_id: string | null; customer_name: string | null; bill_email: string | null
  currency: string | null; total_amt: string | null; balance: string | null; txn_date: string | null; due_date: string | null; last_read_at: string | null
  reminders_sent: number; last_reminder_at: string | null; next_reminder_at: string | null; promised_date: string | null; hold_until: string | null
  thread_message_id: string | null; last_message_id: string | null; synced_action_id: string | null
}
const LIVE: InvoiceStatus[] = ['open', 'held', 'disputed', 'stopped', 'exhausted']

export class ReceivablesBlocked extends Error { constructor(m: string) { super(m); this.name = 'ReceivablesBlocked' } }

// ---------------------------------------------------------------- detection rules (shared with the discovery detector)

export const dedupeKeyFor = (realmId: string, invoiceId: string) => `quickbooks:${realmId}:invoice:${invoiceId}:overdue`
export const recordFor = (realmId: string, inv: Pick<QboInvoice, 'id' | 'docNumber'>) => ({ type: 'qbo_invoice', id: `${realmId}:${inv.id}`, label: `Invoice ${inv.docNumber ?? inv.id}` })

export type Rules = { overdueDays: number; minBalance: number; excludeCustomerIds: string[] }
export const DEFAULT_RULES: Rules = { overdueDays: 7, minBalance: 0, excludeCustomerIds: [] }
export type Skip = 'no_balance' | 'no_due_date' | 'not_due' | 'not_overdue_enough' | 'below_minimum' | 'excluded_customer' | 'marked_in_quickbooks' | 'no_billing_email'
export type Eligibility = { eligible: true; daysOverdue: number } | { eligible: false; reason: Skip; daysOverdue: number }
/** A note in the invoice's private memo that stops reminders: "disputed", "in dispute", "no reminders", "do not chase". */
const NO_REMINDER_NOTE = /\b(disputed?|in dispute|no[- ]reminders?|do not (remind|chase)|don'?t (remind|chase))\b/i

/** Is this invoice (as just read) overdue enough to remind? `today` is the business's local date (YYYY-MM-DD). */
export function overdueStatus(inv: QboInvoice, rules: Rules, today: string): Eligibility {
  const days = inv.dueDate ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${inv.dueDate}T00:00:00Z`)) / DAY) : 0
  const no = (reason: Skip): Eligibility => ({ eligible: false, reason, daysOverdue: days })
  if (cents(inv.balance) <= 0) return no('no_balance')
  if (!inv.dueDate) return no('no_due_date')
  if (days <= 0) return no('not_due')
  if (days < rules.overdueDays) return no('not_overdue_enough')
  if (inv.balance < rules.minBalance) return no('below_minimum')
  if (inv.customerId && rules.excludeCustomerIds.includes(inv.customerId)) return no('excluded_customer')
  if (inv.privateNote && NO_REMINDER_NOTE.test(inv.privateNote)) return no('marked_in_quickbooks')
  if (!inv.billEmail) return no('no_billing_email')
  return { eligible: true, daysOverdue: days }
}

/** An amount exactly as QuickBooks gave it, with its currency (no rounding beyond cents). */
export function formatMoney(n: number | string | null, currency: string | null): string {
  const v = Number(n ?? 0)
  if (currency && /^[A-Z]{3}$/.test(currency)) { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code' }).format(v).replace(/ /g, ' ') } catch { /* unknown code */ } }
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)
}
export const formatDate = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d.slice(0, 10)}T00:00:00Z`)) : 'unknown')
const clean = (s: string | null | undefined, n = 80) => (s ?? '').replace(/[\r\n<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

// ---------------------------------------------------------------- reminder content (from the QuickBooks read only)

export type ReminderFacts = { docNumber: string | null; qboInvoiceId: string; customerName: string | null; currency: string | null; totalAmt: number | string | null; balance: number | string | null; dueDate: string | null; txnDate: string | null }

export function reminderDraft(f: ReminderFacts, n: number, max: number, senderName: string, firstSubject: string | null): EmailDraft {
  const doc = clean(f.docNumber, 40) || f.qboInvoiceId
  const balance = formatMoney(f.balance, f.currency), total = formatMoney(f.totalAmt, f.currency)
  const part = cents(f.balance) !== cents(f.totalAmt)
  const opener = n === 1 ? 'This is a friendly reminder that' : n >= max ? 'This is our final reminder that' : 'Following up on our earlier note:'
  const subject = n === 1 || !firstSubject ? `Invoice ${doc}: ${balance} overdue since ${formatDate(f.dueDate)}` : (/^re:/i.test(firstSubject) ? firstSubject : `Re: ${firstSubject}`)
  const body = `Hello ${clean(f.customerName) || 'there'},\n\n${opener} invoice ${doc}${f.txnDate ? ` dated ${formatDate(f.txnDate)}` : ''} was due on ${formatDate(f.dueDate)}. `
    + `The balance still open is ${balance}${part ? ` of ${total} (thank you for the payment received so far)` : ''}.\n\n`
    + 'If you have already paid, thank you, and please reply to let us know so we can match the payment. If something on the invoice is not right, reply and tell us; we will look into it before sending any further reminder.\n\n'
    + `Best regards,\n${clean(senderName)}`
  return { subject: subject.slice(0, 250), body }
}

// ---------------------------------------------------------------- reply classification (data only)

export type ReplyCategory = 'unsubscribe' | 'dispute' | 'paid_claim' | 'promise' | 'other'
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const iso = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null
}
const monthOf = (w: string) => MONTHS.findIndex(m => m === w || (w.length >= 3 && m.startsWith(w))) + 1

/** The first date in a reply that is after `today` and within 120 days (ISO, "20 November", "November 20th", "tomorrow", "Friday"). */
export function promisedDate(text: string, today: string): string | null {
  const t = text.toLowerCase()
  const base = Date.parse(`${today}T00:00:00Z`)
  const ok = (d: string | null) => (d && Date.parse(`${d}T00:00:00Z`) > base && Date.parse(`${d}T00:00:00Z`) <= base + 120 * DAY ? d : null)
  const year = Number(today.slice(0, 4))
  const withYear = (m: number, d: number, y?: string) => y ? iso(Number(y), m, d) : (ok(iso(year, m, d)) ?? iso(year + 1, m, d))
  const found: { at: number; date: string | null }[] = []
  for (const m of t.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)) found.push({ at: m.index!, date: iso(Number(m[1]), Number(m[2]), Number(m[3])) })
  const mon = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${mon}\\.?(?:,? (20\\d\\d))?\\b`, 'g'))) found.push({ at: m.index!, date: withYear(monthOf(m[2].replace('sept', 'sep')), Number(m[1]), m[3]) })
  for (const m of t.matchAll(new RegExp(`\\b${mon}\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (20\\d\\d))?\\b`, 'g'))) found.push({ at: m.index!, date: withYear(monthOf(m[1].replace('sept', 'sep')), Number(m[2]), m[3]) })
  for (const m of t.matchAll(/\btomorrow\b/g)) found.push({ at: m.index!, date: new Date(base + DAY).toISOString().slice(0, 10) })
  for (const m of t.matchAll(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g)) {
    const want = WEEKDAYS.indexOf(m[1]), now = new Date(base).getUTCDay()
    found.push({ at: m.index!, date: new Date(base + (((want - now + 7) % 7) || 7) * DAY).toISOString().slice(0, 10) })
  }
  for (const f of found.sort((a, b) => a.at - b.at)) { const d = ok(f.date); if (d) return d }
  return null
}

/**
 * One category for a reply to a reminder. Order matters: an unsubscribe or a dispute always wins (a person
 * decides), then "we paid" (verified in QuickBooks, never believed), then a promise with a date.
 */
export function classifyReceivableReply(subject: string, text: string, today: string): { category: ReplyCategory; promisedDate: string | null } {
  const t = `${subject}\n${newText(text)}`.toLowerCase().replace(/[‘’]/g, "'")
  if (/\b(unsubscribe|opt[ -]?out|remove me|stop (emailing|contacting|sending)|do not (contact|email)|don'?t (contact|email))\b/.test(t)) return { category: 'unsubscribe', promisedDate: null }
  if (/\b(dispute[ds]?|disputing|contest(?:ed|ing)?|incorrect|inaccurate|wrong (?:amount|invoice|price|total|rate)|(?:invoice|amount|total|price|bill|charge) (?:is|was|looks|seems) (?:wrong|incorrect|too high)|over-?charg\w*|never (?:received|ordered|got)|did not (?:receive|order)|didn'?t (?:receive|order)|not what we (?:ordered|agreed)|do not owe|don'?t owe|not owed|refuse to pay|chargeback|billing error|error (?:on|in) (?:the|this|your) invoice)\b/.test(t))
    return { category: 'dispute', promisedDate: null }
  if (/\b(already paid|already settled|(?:have|has|had|we've|i've|we have|i have) (?:already )?(?:paid|settled|sent (?:the |a |our )?payment|transferred|wired)|payment (?:was|has been|is) (?:sent|made|processed|completed|submitted|on its way)|(?:sent|made|wired|transferred) (?:the |a |our )?payment|paid (?:it|this|that|the invoice|in full)|remittance)\b/.test(t))
    return { category: 'paid_claim', promisedDate: null }
  if (/\b(will|we'll|i'll|shall|going to|plan to|intend to|expect to|aim to)\b[^.!?\n]{0,40}\b(pay|settle|send (?:the |a )?payment|transfer|process (?:the )?payment|remit)\b/.test(t) || /\bpayment (?:will|should) (?:go out|be sent|be made|arrive|be processed)\b/.test(t)) {
    const d = promisedDate(t, today)
    if (d) return { category: 'promise', promisedDate: d }
  }
  return { category: 'other', promisedDate: null }
}

// ---------------------------------------------------------------- shared helpers

const evidenceOf = (realmId: string, inv: QboInvoice, label?: string): Evidence => ({
  label: (label ?? `QuickBooks: invoice ${inv.docNumber ?? inv.id} has ${formatMoney(inv.balance, inv.currency)} open of ${formatMoney(inv.totalAmt, inv.currency)}, due ${inv.dueDate ?? 'no date'}`).slice(0, 300),
  source: SOURCE_APP, observedAt: new Date().toISOString(),
  detail: { invoiceId: inv.id, docNumber: inv.docNumber, balance: inv.balance, totalAmt: inv.totalAmt, currency: inv.currency, dueDate: inv.dueDate, linkedPaymentIds: inv.linkedPaymentIds, lastUpdated: inv.updatedAt, read: 'QuickBooks Online invoice read' },
  ref: { type: 'qbo_invoice', id: `${realmId}:${inv.id}` },
})

/** Statuses a case may pass through on the way (the lifecycle allows no shortcut); the shortest path, or null. */
function pathTo(from: CaseStatus, to: CaseStatus): CaseStatus[] | null {
  if (from === to) return []
  if (canTransition(from, to)) return [to]
  const seen = new Set<CaseStatus>([from]), queue: { s: CaseStatus; path: CaseStatus[] }[] = [{ s: from, path: [] }]
  while (queue.length) {
    const { s, path } = queue.shift()!
    for (const n of TRANSITIONS[s]) {
      if (seen.has(n)) continue
      seen.add(n)
      if (canTransition(n, to)) return [...path, n, to]
      if (path.length < 2) queue.push({ s: n, path: [...path, n] })
    }
  }
  return null
}

/** Move a case to `to` (through the allowed steps), setting the next check and next action. Terminal cases are left alone. */
async function moveCase(db: Db, caseId: string, to: CaseStatus, reason: string, actor: string, o: { nextCheckAt?: Date | null; nextAction?: string | null; approvalRequired?: boolean; evidence?: Evidence[]; ref?: { type: string; id: string } } = {}) {
  const c = await db.one<CaseRow>('select * from cases where id = $1', [caseId])
  if (!c || TERMINAL.includes(c.status)) return
  const path = pathTo(c.status, to)
  if (!path) { log.warn('office.receivables.case_path', { from: c.status, to }); return }
  if (!path.length) {
    await db.query(`update cases set next_check_at = case when $2::boolean then $3::timestamptz else next_check_at end, next_action = case when $4::boolean then $5 else next_action end, status_reason = $6 where id = $1`,
      [caseId, o.nextCheckAt !== undefined, o.nextCheckAt?.toISOString() ?? null, o.nextAction !== undefined, o.nextAction ?? null, reason.slice(0, 1000)])
    if (o.evidence?.length) for (const e of o.evidence) await addEvidence(db, caseId, e, actor)
    return
  }
  for (const [i, s] of path.entries()) {
    const last = i === path.length - 1
    await transitionCase(db, caseId, { to: s, actor, reason, ...(last ? { nextCheckAt: o.nextCheckAt, nextAction: o.nextAction, approvalRequired: o.approvalRequired ?? false, evidence: o.evidence, ref: o.ref ?? null } : {}) })
  }
}

async function cancelPending(db: Db, row: Pick<InvoiceRow, 'id' | 'org_id'>, reason: string) {
  return db.query<{ id: string }>(`update office_actions set status = 'cancelled', status_reason = $3, next_attempt_at = null where org_id = $1 and kind = 'send_email'
    and payload->'recipientSource'->>'kind' = 'invoice' and payload->'recipientSource'->>'invoiceId' = $2 and status in ('draft','awaiting_approval','queued') returning id`, [row.org_id, row.id, reason.slice(0, 300)])
}

async function snapshot(db: Db, rowId: string, inv: QboInvoice) {
  return (await db.one<InvoiceRow>(`update office_invoices set doc_number = $2, customer_id = $3, customer_name = $4, bill_email = $5, currency = $6, total_amt = $7, balance = $8, txn_date = $9, due_date = $10, last_read_at = now()
    where id = $1 returning *`, [rowId, inv.docNumber, inv.customerId, inv.customerName, inv.billEmail, inv.currency, inv.totalAmt, inv.balance, inv.txnDate, inv.dueDate]))!
}

const actorOf = (ctx: AgentCtx) => `office-agent:${ctx.agent.name.slice(0, 60)}@v${ctx.policyVersion}`
const localDay = (tz: string, now: Date) => formatInTimeZone(now, tz, 'yyyy-MM-dd')
const at = (date: string, hhmm: string, tz: string) => fromZonedTime(`${date}T${hhmm}:00`, tz)
const minDate = (...d: (Date | null | undefined)[]) => new Date(Math.min(...d.filter((x): x is Date => Boolean(x)).map(x => x.getTime())))

async function quickbooksConnection(db: Db, orgId: string, id: string | null): Promise<OfficeConnectionRow | null> {
  if (!id) return null
  return db.one<OfficeConnectionRow>(`select * from office_connections where id = $1 and org_id = $2 and provider = 'quickbooks' and status = 'active'`, [id, orgId])
}

/** A QuickBooks 401 on a read means the grant is gone: the connection needs reconnecting. */
async function onAuthFailure(conn: OfficeConnectionRow, e: unknown) {
  if (!(e instanceof OfficeHttpError && e.code === 'auth') || conn.is_synthetic) return
  await admin(async db => {
    await db.query(`update office_connections set status = 'needs_reauth', status_reason = $2 where id = $1 and status = 'active'`, [conn.id, 'QuickBooks no longer accepts this connection (revoked or expired)'])
    await officeAudit(db, { orgId: conn.org_id, entityType: 'office_connection', entityId: conn.id, event: 'connection.needs_reauth', actor: 'system:office', detail: { provider: 'quickbooks' } })
  })
}

// ---------------------------------------------------------------- verification (a fresh read of QuickBooks)

/**
 * Read the invoice again and act on what QuickBooks shows: balance 0 -> resolved (the read is the evidence,
 * with any linked payments); voided or deleted -> cancelled; a smaller balance -> part payment, still open.
 */
export async function verifyInvoice(row: InvoiceRow, api: QuickBooksApi, actor: string, now: Date): Promise<'paid' | 'open' | 'closed'> {
  const fresh = await api.getInvoice(row.qbo_invoice_id)
  if (!fresh || (cents(fresh.balance) <= 0 && cents(fresh.totalAmt) <= 0)) {
    await admin(async db => {
      await db.query(`update office_invoices set status = 'closed', status_reason = $2, next_reminder_at = null, last_read_at = now() where id = $1`, [row.id, fresh ? 'voided in QuickBooks' : 'no longer in QuickBooks'])
      await cancelPending(db, row, 'the invoice was voided or deleted in QuickBooks')
      if (row.case_id) await moveCase(db, row.case_id, 'cancelled', fresh ? `Invoice ${row.doc_number ?? row.qbo_invoice_id} was voided in QuickBooks: nothing to collect` : `Invoice ${row.doc_number ?? row.qbo_invoice_id} no longer exists in QuickBooks: nothing to collect`, actor,
        { evidence: [fresh ? evidenceOf(row.realm_id, fresh, `QuickBooks: invoice ${fresh.docNumber ?? fresh.id} is voided (total 0)`) : { label: `QuickBooks: invoice ${row.doc_number ?? row.qbo_invoice_id} not found`, source: SOURCE_APP, observedAt: new Date().toISOString(), ref: { type: 'qbo_invoice', id: `${row.realm_id}:${row.qbo_invoice_id}` } }] })
    })
    return 'closed'
  }
  if (cents(fresh.balance) <= 0) {
    const payments: Evidence[] = []
    for (const pid of fresh.linkedPaymentIds.slice(0, 5)) {
      const p = await api.getPayment(pid).catch(() => null)
      if (p) payments.push({ label: `QuickBooks: payment ${p.id} of ${formatMoney(p.totalAmt, fresh.currency)}${p.txnDate ? ` on ${p.txnDate}` : ''} applied to invoice ${fresh.docNumber ?? fresh.id}`, source: SOURCE_APP, observedAt: new Date().toISOString(),
        detail: { paymentId: p.id, totalAmt: p.totalAmt, txnDate: p.txnDate, appliedTo: p.appliedTo }, ref: { type: 'qbo_payment', id: `${row.realm_id}:${p.id}` } })
    }
    await admin(async db => {
      await snapshot(db, row.id, fresh)
      await db.query(`update office_invoices set status = 'paid', status_reason = 'QuickBooks shows the balance at zero', next_reminder_at = null, hold_until = null where id = $1`, [row.id])
      await cancelPending(db, row, 'QuickBooks shows the invoice paid')
      const c = row.case_id ? await db.one<CaseRow>('select * from cases where id = $1', [row.case_id]) : null
      if (c && !TERMINAL.includes(c.status)) {
        await resolveCase(db, c.id, { actor, verifiedBy: VERIFIER, summary: `Paid: QuickBooks shows invoice ${fresh.docNumber ?? fresh.id} with a balance of ${formatMoney(0, fresh.currency)} (total ${formatMoney(fresh.totalAmt, fresh.currency)})`,
          evidence: [evidenceOf(row.realm_id, fresh, `QuickBooks: invoice ${fresh.docNumber ?? fresh.id} balance ${formatMoney(fresh.balance, fresh.currency)} (paid)`), ...payments] })
      }
      await officeAudit(db, { orgId: row.org_id, entityType: 'office_invoice', entityId: row.id, event: 'invoice.paid', actor, detail: { qbo_invoice_id: fresh.id, payments: fresh.linkedPaymentIds } })
    })
    return 'paid'
  }
  await applyRead(row, fresh, actor, now)
  return 'open'
}

/** Store a read; a lower (non-zero) balance is a part payment: evidence on the case, stale reminders cancelled. */
async function applyRead(row: InvoiceRow, inv: QboInvoice, actor: string, _now?: Date): Promise<InvoiceRow> {
  return admin(async db => {
    const partial = row.balance !== null && cents(inv.balance) < cents(row.balance) && cents(inv.balance) > 0
    const changed = row.balance !== null && (cents(inv.balance) !== cents(row.balance) || (inv.billEmail ?? null) !== row.bill_email || inv.dueDate !== (row.due_date ? String(row.due_date).slice(0, 10) : null))
    const next = await snapshot(db, row.id, inv)
    if (changed) await cancelPending(db, row, 'the invoice changed in QuickBooks; a new reminder is prepared from the current figures')
    if (partial && row.case_id) {
      const c = await db.one<CaseRow>('select status from cases where id = $1', [row.case_id])
      if (c && !TERMINAL.includes(c.status)) await addEvidence(db, row.case_id, evidenceOf(row.realm_id, inv, `QuickBooks: part payment received; invoice ${inv.docNumber ?? inv.id} now has ${formatMoney(inv.balance, inv.currency)} open (was ${formatMoney(row.balance, inv.currency)})`), actor)
    }
    return next
  })
}

// ---------------------------------------------------------------- the agent run

export async function runReceivables(ctx: AgentCtx, now: Date, counts: Counts) {
  const p = ctx.policy!
  if (!p.receivables) throw new ReceivablesBlocked('the agent has no receivables settings')
  if (!(await admin(db => hasProduct(db, ctx.agent.org_id, 'office')))) throw new ReceivablesBlocked('Deploi Office is not enabled for this organization')
  const conn = await admin(db => quickbooksConnection(db, ctx.agent.org_id, p.quickbooksConnectionId))
  if (!conn) throw new ReceivablesBlocked(await officeBlockReason(ctx.agent.org_id, p.quickbooksConnectionId, 'QuickBooks'))
  const api = quickbooksFor(conn)
  try {
    await handleReplies(ctx, api, now, counts)
    await detect(ctx, conn, api, now, counts)
    await syncReceivables(ctx, now, counts)
    await proposeDue(ctx, now, counts)
  } catch (e) {
    await onAuthFailure(conn, e)
    if (e instanceof OfficeHttpError && e.code === 'auth') throw new OfficeAuthError('QuickBooks no longer accepts this connection; reconnect it')
    throw e
  }
}

async function detect(ctx: AgentCtx, conn: OfficeConnectionRow, api: QuickBooksApi, now: Date, counts: Counts) {
  const p = ctx.policy!, r = p.receivables!
  const today = localDay(p.timezone, now)
  const actor = actorOf(ctx)
  const seen = new Set<string>()
  let start = 1, complete = false
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await api.listOpenInvoices({ startPosition: start, maxResults: QBO_PAGE })
    for (const inv of res.invoices) {
      seen.add(inv.id)
      inc(counts, 'invoices_read')
      const e = overdueStatus(inv, r, today)
      const row = await admin(db => db.one<InvoiceRow>('select * from office_invoices where connection_id = $1 and qbo_invoice_id = $2', [conn.id, inv.id]))
      if (row && row.agent_id !== ctx.agent.id) continue // another Accounts Receivable agent follows this invoice
      if (!e.eligible) {
        if (row && (row.status === 'open' || row.status === 'held') && ['excluded_customer', 'marked_in_quickbooks', 'no_billing_email', 'below_minimum'].includes(e.reason)) {
          const why = e.reason === 'excluded_customer' ? 'the customer is excluded from reminders' : e.reason === 'marked_in_quickbooks' ? "the invoice's note in QuickBooks says not to remind" : e.reason === 'below_minimum' ? 'the open balance is below the minimum for reminders' : 'the invoice has no billing email in QuickBooks'
          await admin(async db => {
            await snapshot(db, row.id, inv)
            await db.query(`update office_invoices set status = 'stopped', status_reason = $2, next_reminder_at = null where id = $1`, [row.id, why])
            await cancelPending(db, row, `reminders stopped: ${why}`)
            if (row.case_id) await moveCase(db, row.case_id, 'escalated', `Reminders stopped: ${why}. Over to you.`, actor, { nextAction: 'Decide how to follow up on this invoice', nextCheckAt: new Date(now.getTime() + DAY) })
          })
        }
        if (row && LIVE.includes(row.status)) await applyRead(row, inv, actor, now)
        continue
      }
      if (row && LIVE.includes(row.status)) { await applyRead(row, inv, actor, now); continue }
      await track(ctx, conn, inv, e.daysOverdue, row, now)
      inc(counts, 'detected')
    }
    if (!res.next) { complete = true; break }
    start = res.next
  }
  if (!complete) return
  // tracked invoices that are no longer open in the listing: read each one again (paid, voided or deleted)
  const gone = await admin(db => db.query<InvoiceRow>(`select * from office_invoices where agent_id = $1 and connection_id = $2 and status = any($3::text[]) order by updated_at limit 100`, [ctx.agent.id, conn.id, LIVE]))
  for (const row of gone.filter(g => !seen.has(g.qbo_invoice_id))) {
    const out = await verifyInvoice(row, api, actor, now)
    inc(counts, out === 'paid' ? 'resolved' : out === 'closed' ? 'closed' : 'still_open')
  }
}

/** The case for an overdue invoice, every value from the QuickBooks read (shared with the discovery detector). */
export function overdueFinding(realm: string, inv: QboInvoice, days: number) {
  const doc = inv.docNumber ?? inv.id, who = clean(inv.customerName, 120) || 'a customer'
  return {
    kind: CASE_KIND, dedupeKey: dedupeKeyFor(realm, inv.id),
    title: `Invoice ${doc} from ${who} is ${days} day${days === 1 ? '' : 's'} overdue`,
    problem: `QuickBooks shows invoice ${doc} for ${who} with ${formatMoney(inv.balance, inv.currency)} open of ${formatMoney(inv.totalAmt, inv.currency)}, due ${formatDate(inv.dueDate)} (${days} days ago).`,
    whyItMatters: 'An unpaid invoice is money the business has earned but not received; the longer it waits, the harder it is to collect.',
    priority: (days > 60 ? 'high' : 'normal') as 'high' | 'normal',
    evidence: [evidenceOf(realm, inv)], records: [recordFor(realm, inv)],
    verification: { criteria: `A fresh QuickBooks read shows invoice ${doc} with a balance of 0`, rule: { source: SOURCE_APP, realmId: realm, invoiceId: inv.id, balance: 0 } },
  }
}

/** Start following an overdue invoice: one row, one case (the open case for the same invoice if discovery opened it). */
async function track(ctx: AgentCtx, conn: OfficeConnectionRow, inv: QboInvoice, days: number, old: InvoiceRow | null, now: Date) {
  const actor = actorOf(ctx), realm = conn.external_account_id
  const f = overdueFinding(realm, inv, days)
  await admin(async db => {
    const { case: c, created } = await openCase(db, {
      orgId: ctx.agent.org_id, suite: 'office', kind: f.kind, sourceApp: SOURCE_APP, dedupeKey: f.dedupeKey, actor, title: f.title, problem: f.problem, whyItMatters: f.whyItMatters,
      priority: f.priority, agent: { kind: 'office', ref: ctx.agent.id }, evidence: f.evidence, records: f.records, verification: f.verification,
      nextAction: 'Prepare a payment reminder to the invoice\'s billing address', nextCheckAt: new Date(now.getTime() + DAY),
    })
    if (!created && !c.agent_ref) await handOffCase(db, c.id, { kind: 'office', ref: ctx.agent.id }, { actor, reason: 'The Accounts Receivable agent follows this invoice' })
    const row = old
      ? (await db.one<InvoiceRow>(`update office_invoices set status = 'open', status_reason = null, case_id = $2, reminders_sent = 0, last_reminder_at = null, next_reminder_at = null, promised_date = null, hold_until = null,
          thread_message_id = null, last_message_id = null, synced_action_id = null where id = $1 returning *`, [old.id, c.id]))!
      : (await db.one<InvoiceRow>(`insert into office_invoices (org_id, agent_id, connection_id, realm_id, qbo_invoice_id, case_id) values ($1,$2,$3,$4,$5,$6) returning *`, [ctx.agent.org_id, ctx.agent.id, conn.id, realm, inv.id, c.id]))!
    await snapshot(db, row.id, inv)
    await officeAudit(db, { orgId: ctx.agent.org_id, entityType: 'office_invoice', entityId: row.id, event: 'invoice.tracked', actor, detail: { qbo_invoice_id: inv.id, case: c.ref, days_overdue: days } })
  })
}

/** Reflect what happened to reminder actions (sent, declined, failed) on the invoice and its case. */
export async function syncReceivables(ctx: AgentCtx, now: Date, counts: Counts = {}, onlyRowId?: string) {
  const p = ctx.policy
  const cadence = p?.receivables?.cadenceDays ?? 7
  const rows = await admin(db => db.query<InvoiceRow>(`select * from office_invoices where agent_id = $1 and case_id is not null and ($2::uuid is null or id = $2) and status <> 'closed' limit 500`, [ctx.agent.id, onlyRowId ?? null]))
  for (const row of rows) {
    const acts = await admin(db => db.query<OfficeActionRow>(`select * from office_actions where org_id = $1 and agent_id = $2 and kind = 'send_email' and payload->'recipientSource'->>'invoiceId' = $3
      and status in ('succeeded','failed','rejected') and ($4::uuid is null or created_at > (select created_at from office_actions where id = $4)) order by created_at`, [row.org_id, ctx.agent.id, row.id, row.synced_action_id]))
    for (const a of acts) {
      const n = Number((a.payload as EmailPayload).meta.reminder ?? row.reminders_sent + 1)
      const actor = a.approved_by ?? actorOf(ctx)
      await admin(async db => {
        if (a.status === 'succeeded') {
          const sentAt = new Date(a.executed_at ?? now)
          const next = new Date(sentAt.getTime() + cadence * DAY)
          await db.query(`update office_invoices set reminders_sent = greatest(reminders_sent, $2), last_reminder_at = $3, next_reminder_at = case when status = 'open' then $4 else next_reminder_at end,
            thread_message_id = coalesce(thread_message_id, $5), last_message_id = $5, synced_action_id = $6 where id = $1`, [row.id, n, sentAt.toISOString(), next.toISOString(), a.email_message_id, a.id])
          if (row.case_id) {
            await recordAction(db, row.case_id, { actor, summary: `Sent reminder ${n} to ${(a.payload as EmailPayload).to}`, ref: a.email_message_id ? { type: 'email_message', id: a.email_message_id } : { type: 'office_action', id: a.id } }).catch(ignoreClosed)
            if (row.status === 'open') await moveCase(db, row.case_id, 'waiting_external', `Reminder ${n} sent to ${(a.payload as EmailPayload).to}; waiting for payment`, actor,
              { nextCheckAt: minDate(next, new Date(now.getTime() + DAY)), nextAction: `Check QuickBooks for payment; reminder ${n + 1} after ${next.toISOString().slice(0, 10)} if still unpaid` })
          }
          inc(counts, 'reminders_sent')
        } else {
          const why = a.status === 'rejected' ? `you declined reminder ${n}` : `reminder ${n} could not be sent: ${a.status_reason ?? 'failed'}`
          await db.query(`update office_invoices set status = case when status in ('open','held') then 'stopped' else status end, status_reason = $2, next_reminder_at = null, synced_action_id = $3 where id = $1`, [row.id, why, a.id])
          if (row.case_id) await moveCase(db, row.case_id, 'blocked', `No more reminders for this invoice: ${why}. Payment is still checked in QuickBooks.`, actor, { nextCheckAt: new Date(now.getTime() + DAY), nextAction: 'Follow up yourself, or resume with a new agent version' })
        }
      })
    }
  }
}
const ignoreClosed = (e: unknown) => { if (!(e instanceof EngineError)) throw e }

/** Prepare the next reminder for each open invoice that is due one (one pending reminder per invoice at most). */
async function proposeDue(ctx: AgentCtx, now: Date, counts: Counts) {
  const p = ctx.policy!, r = p.receivables!
  const actor = actorOf(ctx)
  // holds that have ended (promised date passed, the grace after "we paid"): reminders resume
  const resumed = await admin(db => db.query<InvoiceRow>(`update office_invoices set status = 'open', status_reason = 'the hold ended and QuickBooks still shows a balance', hold_until = null, next_reminder_at = $3
    where agent_id = $1 and status = 'held' and hold_until is not null and hold_until <= $2 returning *`, [ctx.agent.id, now.toISOString(), now.toISOString()]))
  for (const row of resumed) if (row.case_id) await admin(db => addNote(db, row.case_id!, `${row.promised_date ? `The promised date (${row.promised_date.slice(0, 10)}) passed` : 'The wait after the customer said it was paid ended'} and QuickBooks still shows ${formatMoney(row.balance, row.currency)} open; reminders resume`, actor))
  const due = await admin(db => db.query<InvoiceRow>(`select * from office_invoices where agent_id = $1 and status = 'open' and case_id is not null and (next_reminder_at is null or next_reminder_at <= $2) and last_read_at > $3 order by due_date limit 50`,
    [ctx.agent.id, now.toISOString(), new Date(Date.now() - 3600e3).toISOString()]))
  for (const row of due) {
    const pending = await admin(db => db.one<OfficeActionRow>(`select * from office_actions where org_id = $1 and kind = 'send_email' and payload->'recipientSource'->>'invoiceId' = $2 and status in ('draft','awaiting_approval','queued','executing','unknown') order by created_at desc limit 1`, [row.org_id, row.id]))
    // a draft made under an older authorization is offered again under the current one (e.g. after widening to "after my approval")
    if (pending && !(pending.status === 'draft' && (pending.policy_version ?? 0) < ctx.policyVersion)) continue
    if (pending) await admin(db => db.query(`update office_actions set status = 'cancelled', status_reason = 'replaced under the current authorization' where id = $1 and status = 'draft'`, [pending.id]))
    if (row.reminders_sent >= r.maxReminders) {
      await admin(async db => {
        await db.query(`update office_invoices set status = 'exhausted', status_reason = $2, next_reminder_at = null where id = $1`, [row.id, `all ${r.maxReminders} reminders sent`])
        await moveCase(db, row.case_id!, 'escalated', `All ${r.maxReminders} reminders sent and QuickBooks still shows ${formatMoney(row.balance, row.currency)} open. Over to you.`, actor,
          { nextAction: 'Call the customer or decide on next steps', nextCheckAt: new Date(now.getTime() + DAY) })
      })
      inc(counts, 'escalated')
      continue
    }
    const n = row.reminders_sent + 1
    const first = row.thread_message_id ? await admin(db => db.one<{ meta: Record<string, unknown> }>('select meta from email_messages where id = $1', [row.thread_message_id])) : null
    const facts: ReminderFacts = { docNumber: row.doc_number, qboInvoiceId: row.qbo_invoice_id, customerName: row.customer_name, currency: row.currency, totalAmt: row.total_amt, balance: row.balance, dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null, txnDate: row.txn_date ? String(row.txn_date).slice(0, 10) : null }
    const d = reminderDraft(facts, n, r.maxReminders, r.senderName, (first?.meta.subject as string | undefined) ?? null)
    const key = `ar:${ctx.agent.id}:${row.id}:r${n}:${cents(row.balance)}:${facts.dueDate}:${sha(row.bill_email ?? '').slice(0, 10)}`
    await admin(async db => {
      const { action, duplicate } = await proposeAction(db, { agentId: ctx.agent.id, kind: 'send_email', purpose: `Payment reminder ${n} for invoice ${facts.docNumber ?? facts.qboInvoiceId}`, idempotencyKey: key, now,
        payload: { type: 'email', to: row.bill_email!, subject: d.subject, body: d.body, inReplyToMessageId: n === 1 ? null : row.thread_message_id, recipientSource: { kind: 'invoice', invoiceId: row.id },
          meta: { reminder: n, invoiceRowId: row.id, qboInvoiceId: row.qbo_invoice_id, docNumber: facts.docNumber, balance: Number(row.balance), totalAmt: Number(row.total_amt), currency: row.currency, dueDate: facts.dueDate, subject: d.subject } } })
      if (duplicate && !['draft', 'awaiting_approval', 'queued'].includes(action.status)) return
      await recordAction(db, row.case_id!, { actor, summary: `Prepared reminder ${n} for ${row.bill_email} (${action.status.replace('_', ' ')})`, ref: { type: 'office_action', id: action.id } })
      if (action.status === 'draft') await moveCase(db, row.case_id!, 'proposed', `Reminder ${n} drafted for your review (drafts only: nothing is sent)`, actor, { nextAction: `Review reminder ${n}; send it yourself or allow the agent to send after your approval`, nextCheckAt: new Date(now.getTime() + DAY) })
      else if (action.status === 'awaiting_approval') await moveCase(db, row.case_id!, 'awaiting_approval', `Reminder ${n} waits for your approval`, actor, { approvalRequired: true, nextAction: `Approve or decline reminder ${n}`, nextCheckAt: new Date(now.getTime() + DAY) })
      else if (action.status === 'queued') await moveCase(db, row.case_id!, 'executing', `Sending reminder ${n} under the standing authorization`, actor, { nextCheckAt: new Date(now.getTime() + DAY) })
      else await moveCase(db, row.case_id!, 'blocked', `Reminder ${n} could not be prepared: ${action.status_reason ?? action.status}`, actor, { nextCheckAt: new Date(now.getTime() + DAY) })
    })
    inc(counts, 'proposed')
  }
}

// ---------------------------------------------------------------- replies

type Inbound = { id: string; org_id: string; from_address: string; thread_message_id: string | null; key_id: string; content_ciphertext: string }

async function handleReplies(ctx: AgentCtx, api: QuickBooksApi, now: Date, counts: Counts) {
  const p = ctx.policy!
  if (!p.mailboxAccountId) return
  const actor = actorOf(ctx)
  const inbound = await admin(db => db.query<Inbound>(`select i.id, i.org_id, i.from_address, i.thread_message_id, i.key_id, i.content_ciphertext from email_inbound i
    where i.account_id = $1 and i.org_id = $2 and i.status = 'accepted' and i.key_id <> 'pending' and i.received_at > $3::timestamptz - interval '1 day'
      and not exists (select 1 from office_inbound_handled h where h.agent_id = $4 and h.inbound_id = i.id) order by i.received_at limit 50`, [p.mailboxAccountId, ctx.agent.org_id, ctx.agent.created_at, ctx.agent.id]))
  const handled = (i: Inbound, category: string, outcome: string) => admin(db => db.query(`insert into office_inbound_handled (org_id, agent_id, inbound_id, classification, outcome) values ($1,$2,$3,$4,$5) on conflict do nothing`, [ctx.agent.org_id, ctx.agent.id, i.id, category, outcome.slice(0, 200)]))
  for (const i of inbound) {
    const a = i.thread_message_id ? await admin(db => db.one<OfficeActionRow>(`select a.* from office_actions a join email_messages m on m.office_action_id = a.id where m.id = $1 and a.org_id = $2 and a.agent_id = $3`, [i.thread_message_id, i.org_id, ctx.agent.id])) : null
    const src = a?.payload.type === 'email' ? a.payload.recipientSource : null
    const row = src?.kind === 'invoice' ? await admin(db => db.one<InvoiceRow>('select * from office_invoices where id = $1 and org_id = $2', [src.invoiceId, ctx.agent.org_id])) : null
    if (!row || !row.bill_email || i.from_address.toLowerCase() !== row.bill_email) { await handled(i, 'not_ours', "not a reply from an invoice's billing address to this agent's reminders"); continue }
    let content: { subject: string; text: string }
    try { content = JSON.parse(decryptSecret(i.key_id, i.content_ciphertext, `email-inbound:${i.id}`)) as { subject: string; text: string } } catch { content = { subject: '', text: '' } }
    const { category, promisedDate: promised } = classifyReceivableReply(content.subject ?? '', content.text ?? '', localDay(p.timezone, now))
    inc(counts, `reply_${category}`)
    const doc = row.doc_number ?? row.qbo_invoice_id
    if (!LIVE.includes(row.status) || !row.case_id) { await handled(i, category, `invoice already ${row.status}`); continue }
    // the case records the category (and a promised date), never the reply's text
    await admin(db => addNote(db, row.case_id!, `The customer replied to a reminder for invoice ${doc}: ${category.replace('_', ' ')}${promised ? ` (promised for ${promised})` : ''}`, actor))
    if (category === 'dispute' || category === 'unsubscribe' || category === 'other') {
      const status: InvoiceStatus = category === 'dispute' ? 'disputed' : 'stopped'
      const why = category === 'dispute' ? 'the customer disputes the invoice' : category === 'unsubscribe' ? 'the customer asked not to be emailed' : 'the customer replied with something a person should answer'
      await admin(async db => {
        await db.query(`update office_invoices set status = $2, status_reason = $3, next_reminder_at = null, hold_until = null where id = $1`, [row.id, status, why])
        await cancelPending(db, row, `reminders stopped: ${why}`)
        await moveCase(db, row.case_id!, 'escalated', `Reminders stopped: ${why}. Over to you.`, actor, { nextAction: 'Read the reply in your mailbox and answer the customer', nextCheckAt: new Date(now.getTime() + DAY) })
        await officeAudit(db, { orgId: row.org_id, entityType: 'office_invoice', entityId: row.id, event: `invoice.${status}`, actor, detail: { category, inbound_id: i.id } })
      })
      await handled(i, category, `reminders stopped; escalated to you (${category})`)
      continue
    }
    if (category === 'promise') {
      const checkAt = at(promised!, '18:00', p.timezone), resume = at(new Date(Date.parse(`${promised}T00:00:00Z`) + DAY).toISOString().slice(0, 10), '09:00', p.timezone)
      await admin(async db => {
        await db.query(`update office_invoices set status = 'held', status_reason = $2, promised_date = $3, hold_until = $4, next_reminder_at = $4 where id = $1`, [row.id, `promised to pay by ${promised}`, promised, resume.toISOString()])
        await cancelPending(db, row, `the customer promised to pay by ${promised}`)
        await moveCase(db, row.case_id!, 'waiting_external', `The customer promised to pay by ${formatDate(promised)}; no reminders until then`, actor, { nextCheckAt: checkAt, nextAction: `Check QuickBooks for payment on ${promised}` })
      })
      await handled(i, category, `held until ${promised}`)
      continue
    }
    // paid_claim: never believed, verified now against QuickBooks
    const grace = p.receivables!.paidClaimGraceDays
    await admin(async db => {
      await db.query(`update office_invoices set status = 'held', status_reason = 'the customer says it is paid; checking QuickBooks', hold_until = $2, next_reminder_at = $2 where id = $1`, [row.id, new Date(now.getTime() + grace * DAY).toISOString()])
      await cancelPending(db, row, 'the customer says the invoice is paid')
      await moveCase(db, row.case_id!, 'verifying', 'The customer says the invoice is paid: checking QuickBooks', actor)
    })
    const out = await verifyInvoice({ ...row, status: 'held' }, api, actor, now)
    if (out === 'open') {
      const fresh = (await admin(db => db.one<InvoiceRow>('select * from office_invoices where id = $1', [row.id])))!
      await admin(db => moveCase(db, row.case_id!, 'waiting_external', `The customer says it is paid, but QuickBooks still shows ${formatMoney(fresh.balance, fresh.currency)} open; checking daily, reminders wait ${grace} days`, actor,
        { nextCheckAt: new Date(now.getTime() + DAY), nextAction: 'Check QuickBooks for the payment', evidence: [{ label: `QuickBooks: invoice ${doc} still has ${formatMoney(fresh.balance, fresh.currency)} open after the customer said it was paid`, source: SOURCE_APP, observedAt: new Date().toISOString(), ref: { type: 'qbo_invoice', id: `${row.realm_id}:${row.qbo_invoice_id}` } }] }))
    }
    await handled(i, category, out === 'paid' ? 'verified paid in QuickBooks' : 'not yet paid in QuickBooks; checking daily')
  }
}

// ---------------------------------------------------------------- the case checker and the send precheck

/** Due case check: a fresh QuickBooks read, and the reminders' outcomes reflected on the case. */
export async function checkInvoiceCase(c: CaseRow, now: Date) {
  const later = async (ms: number) => { await admin(db => db.query('update cases set next_check_at = $2 where id = $1', [c.id, new Date(now.getTime() + ms).toISOString()])) }
  if (!(await admin(db => hasProduct(db, c.org_id, 'office')))) return later(DAY)
  const row = await admin(db => db.one<InvoiceRow>('select * from office_invoices where case_id = $1 and org_id = $2', [c.id, c.org_id]))
  const rule = (c.verification as { rule?: { realmId?: string; invoiceId?: string } }).rule ?? {}
  const conn = await admin(db => row ? quickbooksConnection(db, c.org_id, row.connection_id)
    : db.one<OfficeConnectionRow>(`select * from office_connections where org_id = $1 and provider = 'quickbooks' and status = 'active' and external_account_id = $2`, [c.org_id, String(rule.realmId ?? '')]))
  if (!conn) return later(DAY)
  const api = quickbooksFor(conn)
  const actor = 'system:office-receivables'
  try {
    if (row) {
      const ctx = await admin(db => agentCtx(db, row.agent_id))
      if (ctx) await syncReceivables(ctx, now, {}, row.id)
      const out = await verifyInvoice((await admin(db => db.one<InvoiceRow>('select * from office_invoices where id = $1', [row.id])))!, api, actor, now)
      if (out !== 'open') return
      const fresh = (await admin(db => db.one<InvoiceRow>('select * from office_invoices where id = $1', [row.id])))!
      const next = minDate(new Date(now.getTime() + DAY), fresh.next_reminder_at ? new Date(fresh.next_reminder_at) : null, fresh.hold_until ? new Date(fresh.hold_until) : null)
      await admin(db => db.query('update cases set next_check_at = $2 where id = $1 and status not in (\'resolved\',\'cancelled\')', [c.id, new Date(Math.max(next.getTime(), now.getTime() + 3600e3)).toISOString()]))
      return
    }
    // a case opened by discovery that no agent follows yet: verification only
    if (!rule.invoiceId) return later(DAY)
    const inv = await api.getInvoice(String(rule.invoiceId))
    if (inv && cents(inv.balance) <= 0 && cents(inv.totalAmt) > 0) {
      await admin(db => resolveCase(db, c.id, { actor, verifiedBy: VERIFIER, summary: `Paid: QuickBooks shows invoice ${inv.docNumber ?? inv.id} with a balance of ${formatMoney(0, inv.currency)}`, evidence: [evidenceOf(conn.external_account_id, inv)] }))
      return
    }
    return later(DAY)
  } catch (e) {
    await onAuthFailure(conn, e)
    log.warn('office.receivables.check_failed', { case_id: c.id, error: (e as Error).message?.slice(0, 200) })
    return later(3600e3)
  }
}
registerCaseKind(CASE_KIND, checkInvoiceCase)

/** Just before a reminder goes out: read the invoice again; anything different from the reminder's figures stops it. */
registerEmailPrecheck(async a => {
  const p = a.payload
  if (p.type !== 'email' || p.recipientSource.kind !== 'invoice') return null
  const invoiceId = p.recipientSource.invoiceId
  const row = await admin(db => db.one<InvoiceRow>('select * from office_invoices where id = $1 and org_id = $2', [invoiceId, a.org_id]))
  if (!row || row.status !== 'open') return { status: 'cancelled', reason: `not sent: reminders for this invoice are ${row?.status ?? 'stopped'}` }
  const conn = await admin(db => db.one<OfficeConnectionRow>(`select * from office_connections where id = $1 and org_id = $2`, [row.connection_id, a.org_id]))
  if (!conn || conn.status !== 'active') return { status: 'failed', reason: 'QuickBooks is not connected, so the invoice could not be checked before sending' }
  let fresh: QboInvoice | null
  try { fresh = await quickbooksFor(conn).getInvoice(row.qbo_invoice_id) } catch (e) {
    await onAuthFailure(conn, e)
    if (e instanceof OfficeHttpError && (e.retryable)) return { status: 'queued', reason: 'QuickBooks did not answer the check before sending; trying again shortly', nextAttemptAt: new Date(Date.now() + 5 * 60e3).toISOString() }
    return { status: 'failed', reason: `the invoice could not be checked in QuickBooks before sending: ${(e as Error).message.slice(0, 120)}` }
  }
  const m = p.meta as { balance?: number; dueDate?: string | null; docNumber?: string | null }
  const why = !fresh ? 'the invoice no longer exists in QuickBooks'
    : cents(fresh.balance) <= 0 ? 'QuickBooks shows the invoice paid'
    : cents(fresh.balance) !== cents(m.balance) ? `the balance in QuickBooks changed (now ${formatMoney(fresh.balance, fresh.currency)})`
    : (fresh.billEmail ?? '') !== p.to.toLowerCase() ? "the invoice's billing email changed in QuickBooks"
    : fresh.dueDate !== (m.dueDate ?? null) || (fresh.docNumber ?? null) !== (m.docNumber ?? null) ? 'the invoice number or due date changed in QuickBooks'
    : null
  return why ? { status: 'cancelled', reason: `not sent: ${why}; the next check prepares a reminder from the current figures` } : null
})

/**
 * A reminder that was sent, refused or declined moves its case at once (sent: waiting for payment; otherwise blocked), the same
 * way the next sync would (syncReceivables reads settled actions in order), so an approved reminder that went out
 * never leaves its case at "awaiting approval" until the next run.
 * An approved reminder that cannot go out yet (quiet hours, the day's limit, a provider asking to slow down) is no
 * longer waiting for the owner either: the case moves on to sending, with the real reason it waits.
 */
onOfficeActionSettled(async (actionId, now) => {
  const a = await admin(db => db.one<OfficeActionRow>('select * from office_actions where id = $1', [actionId]))
  if (!a || a.kind !== 'send_email') return
  const p = a.payload as EmailPayload
  if (p.type !== 'email' || p.recipientSource.kind !== 'invoice') return
  const invoiceId = p.recipientSource.invoiceId
  const waiting = async () => {
    const row = await admin(db => db.one<{ case_id: string | null }>('select case_id from office_invoices where id = $1 and org_id = $2', [invoiceId, a.org_id]))
    if (!row?.case_id) return null
    const c = await admin(db => db.one<{ status: string }>('select status from cases where id = $1', [row.case_id]))
    return c?.status === 'awaiting_approval' ? row.case_id : null
  }
  if (a.status === 'succeeded' || a.status === 'failed' || a.status === 'rejected') {
    // only the owner's decision is taken up here; a run's own sends are counted by that run's sync
    if (!(await waiting())) return
    const ctx = await admin(db => agentCtx(db, a.agent_id))
    if (ctx) await syncReceivables(ctx, now, {}, invoiceId)
    return
  }
  if (a.status !== 'queued' || !a.approval_kind) return
  const caseId = await waiting()
  if (!caseId) return
  await admin(async db => {
    const n = Number((p.meta as { reminder?: number } | undefined)?.reminder ?? 1)
    const when = a.next_attempt_at ? new Date(a.next_attempt_at) : null
    await moveCase(db, caseId, 'executing', `Reminder ${n} ${a.approval_kind === 'individual' ? 'approved by you' : 'covered by the standing authorization'}; ${a.status_reason && a.status_reason !== 'approved by you' ? a.status_reason : 'sending'}`, 'system:office-receivables',
      { nextAction: when && when > now ? `Send reminder ${n} at ${when.toISOString().slice(11, 16)} UTC` : `Send reminder ${n}`, nextCheckAt: when && when > now ? when : new Date(now.getTime() + 3600e3) })
  })
})

export type ReceivablesPolicy = NonNullable<OfficePolicy['receivables']>
