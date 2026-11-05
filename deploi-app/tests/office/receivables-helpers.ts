import { admin } from '../../lib/db'
import type { Actor } from '../../lib/engine/actor'
import { connectSyntheticOffice } from '../../lib/office/connections'
import { connectSyntheticMailbox } from '../../lib/office/mailbox'
import { createOfficeAgent, grantOfficePolicy } from '../../lib/office/agents'
import { officeTemplatePolicy } from '../../lib/office/templates'
import { mutateQboSynth, synthInvoice } from '../../lib/office/quickbooks-synthetic'
import type { QboInvoice } from '../../lib/office/quickbooks'
import type { InvoiceRow } from '../../lib/office/receivables'
import type { CaseRow } from '../../lib/cases'
import { NW, merchantActor, resetOffice } from './helpers'
import '../../lib/office/receivables'

export type ArSetup = { actor: Actor; qbId: string; mailboxId: string; org: string }
type Tier = 'draft' | 'send_approved' | 'send_autonomous'

/** A day string `n` days from `d` (UTC). */
export const day = (d: Date, n: number) => new Date(d.getTime() + n * 864e5).toISOString().slice(0, 10)

export async function resetReceivables(m: typeof NW, opts: { enable?: boolean } = {}) {
  await admin(async db => {
    await db.query(`delete from jobs where kind = 'case.check' and org_id = $1`, [m.org])
    await db.query(`delete from cases where org_id = $1 and kind = 'invoice_overdue'`, [m.org])
  })
  await resetOffice(m, opts)
}

export async function setupReceivables(m: typeof NW, invoices: QboInvoice[]): Promise<ArSetup> {
  await resetReceivables(m)
  const actor = await merchantActor(m)
  const qb = await connectSyntheticOffice(actor, 'quickbooks', { demoData: false })
  const mb = await connectSyntheticMailbox(actor, `ar@${m === NW ? 'northwind' : 'harbor'}-office.example`)
  await mutateQboSynth(qb.id, s => { s.invoices = invoices })
  return { actor, qbId: qb.id, mailboxId: mb.id, org: m.org }
}

export async function arAgent(s: ArSetup, tier: Tier = 'draft', patch: (r: Record<string, unknown>) => void = () => {}) {
  const p = officeTemplatePolicy('accounts_receivable', { quickbooksConnectionId: s.qbId, mailboxAccountId: s.mailboxId, timezone: 'UTC', senderName: 'Sam at Northwind' }) as Record<string, Record<string, unknown>>
  // no quiet hours: approvals in tests run on the wall clock, which may be at night
  p.email = { ...p.email, tier, quietHours: null, validUntil: tier === 'send_autonomous' ? new Date(Date.now() + 60 * 864e5).toISOString() : null }
  p.receivables.excludeCustomerIds = ['77']
  patch(p.receivables)
  const r = await createOfficeAgent(s.actor, { kind: 'accounts_receivable', name: 'Receivables', policy: p })
  await grantOfficePolicy(s.actor, r.agentId, r.policyId, r.policyHash)
  return r.agentId
}

export const inv = (id: string, due: string, total: number, o: Omit<Partial<QboInvoice>, 'dueDate'> = {}) =>
  synthInvoice(id, { docNumber: id, totalAmt: total, dueDate: due, txnDate: due, customerId: '58', customerName: 'Acme Studio', billEmail: 'ap@acme-studio.example', ...o })

export const invoices = (agentId: string) => admin(db => db.query<InvoiceRow>('select * from office_invoices where agent_id = $1 order by qbo_invoice_id', [agentId]))
export const caseOf = (id: string) => admin(async db => (await db.one<CaseRow>('select * from cases where id = $1', [id]))!)
export const caseEvents = (id: string) => admin(db => db.query<{ type: string; to_status: string | null; summary: string }>('select type, to_status, summary from case_events where case_id = $1 order by id', [id]))
export type ArAction = { id: string; status: string; status_reason: string | null; payload_hash: string; email_message_id: string | null; payload: { to: string; subject: string; body: string; meta: Record<string, unknown>; recipientSource: Record<string, string> } }
export const arActions = (agentId: string) => admin(db => db.query<ArAction>('select * from office_actions where agent_id = $1 order by created_at', [agentId]))
