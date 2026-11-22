/**
 * Synthetic QuickBooks Online for tests and demos: a stateful company kept in office_synthetic_state (one
 * row per synthetic connection), entirely inside Deploi. It answers the same reads as the real client
 * (lib/office/quickbooks.ts). Faults can be injected (rate limit, server error, rejected token, no answer).
 * A synthetic connection is flagged is_synthetic and is never combined with a real mailbox or connection.
 */
import { admin } from '../db'
import { OfficeHttpError } from './http'
import type { SynthFault } from './synthetic'
import type { QboCustomer, QboInvoice, QboPayment, QuickBooksApi } from './quickbooks'

export type SynthQbo = { company: string; nextId: number; invoices: QboInvoice[]; payments: QboPayment[]; customers: QboCustomer[]; faults: SynthFault[]; calls: string[] }
const empty = (): SynthQbo => ({ company: 'Synthetic company (test only)', nextId: 9000, invoices: [], payments: [], customers: [], faults: [], calls: [] })

export async function getQboSynth(connectionId: string): Promise<SynthQbo> {
  return admin(async db => ({ ...empty(), ...((await db.one<{ state: SynthQbo }>('select state from office_synthetic_state where connection_id = $1', [connectionId]))?.state ?? {}) }))
}

export async function mutateQboSynth<T>(connectionId: string, fn: (s: SynthQbo) => T): Promise<T> {
  return admin(async db => {
    const c = await db.one<{ org_id: string; provider: string }>('select org_id, provider from office_connections where id = $1 and is_synthetic', [connectionId])
    if (!c || c.provider !== 'quickbooks') throw new Error('not a synthetic QuickBooks connection')
    const row = await db.one<{ state: SynthQbo }>('select state from office_synthetic_state where connection_id = $1 for update', [connectionId])
    const s = { ...empty(), ...(row?.state ?? {}) }
    const out = fn(s)
    if (row) await db.query('update office_synthetic_state set state = $2, updated_at = now() where connection_id = $1', [connectionId, JSON.stringify(s)])
    else await db.query('insert into office_synthetic_state (connection_id, org_id, state) values ($1,$2,$3)', [connectionId, c.org_id, JSON.stringify(s)])
    return out
  })
}

export const injectQboFault = (connectionId: string, f: Omit<SynthFault, 'remaining'> & { remaining?: number }) =>
  mutateQboSynth(connectionId, s => { s.faults.push({ remaining: 1, ...f }) })

export function synthInvoice(id: string, o: Partial<QboInvoice> & { totalAmt: number; dueDate: string }): QboInvoice {
  return { id, docNumber: o.docNumber ?? id, txnDate: o.txnDate ?? o.dueDate, dueDate: o.dueDate, totalAmt: o.totalAmt, balance: o.balance ?? o.totalAmt, currency: o.currency ?? 'USD',
    customerId: o.customerId ?? '58', customerName: o.customerName ?? 'Test Customer', billEmail: o.billEmail === undefined ? 'billing@customer.example' : o.billEmail,
    privateNote: o.privateNote ?? null, linkedPaymentIds: o.linkedPaymentIds ?? [], updatedAt: o.updatedAt ?? new Date().toISOString() }
}

/** Record a customer payment against an invoice, as QuickBooks does: a Payment linked to the invoice, and the balance reduced. */
export function applySynthPayment(s: SynthQbo, invoiceId: string, amount: number, txnDate = new Date().toISOString().slice(0, 10)): QboPayment {
  const inv = s.invoices.find(i => i.id === invoiceId)
  if (!inv) throw new Error('no such synthetic invoice')
  const p: QboPayment = { id: String(s.nextId++), totalAmt: amount, txnDate, customerId: inv.customerId, appliedTo: [{ invoiceId, amount }] }
  s.payments.push(p)
  inv.balance = Math.max(0, Math.round((inv.balance - amount) * 100) / 100)
  inv.linkedPaymentIds = [...inv.linkedPaymentIds, p.id]
  inv.updatedAt = new Date().toISOString()
  return p
}

/** Demo data on reserved example domains: one invoice overdue, one overdue without a billing email, one not yet due. */
export function demoInvoices(now = new Date()): QboInvoice[] {
  const day = (n: number) => new Date(now.getTime() + n * 864e5).toISOString().slice(0, 10)
  return [
    synthInvoice('1037', { docNumber: '1037', totalAmt: 1250, dueDate: day(-21), txnDate: day(-51), customerId: '58', customerName: 'Brightpath Studio', billEmail: 'accounts@brightpath.example' }),
    synthInvoice('1041', { docNumber: '1041', totalAmt: 480, dueDate: day(-12), txnDate: day(-42), customerId: '61', customerName: 'Harborline Logistics', billEmail: null }),
    synthInvoice('1046', { docNumber: '1046', totalAmt: 2200, dueDate: day(9), txnDate: day(-21), customerId: '58', customerName: 'Brightpath Studio', billEmail: 'accounts@brightpath.example' }),
  ]
}

function fail(mode: SynthFault['mode']): never {
  if (mode === 'rate_limited') throw new OfficeHttpError(429, 'rate_limited', 'QuickBooks answered 429 (synthetic)', 'quickbooks')
  if (mode === 'server_error') throw new OfficeHttpError(503, 'server', 'QuickBooks answered 503 (synthetic)', 'quickbooks')
  if (mode === 'auth') throw new OfficeHttpError(401, 'auth', 'QuickBooks answered 401 (synthetic)', 'quickbooks')
  throw new OfficeHttpError(0, 'network', 'no response from QuickBooks (synthetic)', 'quickbooks')
}

export function syntheticQuickBooks(connectionId: string): QuickBooksApi {
  const call = async <T>(op: string, fn: (s: SynthQbo) => T): Promise<T> => {
    const r = await mutateQboSynth(connectionId, s => {
      s.calls.push(op)
      const f = s.faults.find(x => (x.op === op || x.op === '*') && x.remaining > 0)
      if (f) { f.remaining--; s.faults = s.faults.filter(x => x.remaining > 0); return { fault: f.mode, value: null } }
      return { fault: null, value: fn(s) }
    })
    if (r.fault) fail(r.fault)
    return r.value as T
  }
  const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
  return {
    companyInfo: () => call('companyInfo', s => ({ name: s.company })),
    listOpenInvoices: ({ startPosition, maxResults }) => call('listOpenInvoices', s => {
      const open = s.invoices.filter(i => i.balance > 0)
      const page = open.slice(startPosition - 1, startPosition - 1 + maxResults)
      return { invoices: copy(page), next: page.length >= maxResults ? startPosition + maxResults : null }
    }),
    getInvoice: id => call('getInvoice', s => copy(s.invoices.find(i => i.id === id) ?? null)),
    getPayment: id => call('getPayment', s => copy(s.payments.find(p => p.id === id) ?? null)),
    getCustomer: id => call('getCustomer', s => copy(s.customers.find(c => c.id === id) ?? null)),
  }
}
