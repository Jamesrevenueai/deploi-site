/**
 * Synthetic providers for the pack ports (tests and demos). Stateful (pack_synthetic_state, one row per
 * organization and port), entirely inside Deploi: nothing leaves the machine. Faults can be injected so the
 * agents' failure paths are tested: an unreachable provider, a bounced address, a full calendar.
 */
import { createHash } from 'node:crypto'
import { admin } from '../db'
import type { CalendarEvent, BusyInterval } from '../office/types'
import { PortError, setSyntheticPorts, type CrmRecord, type Ports, type PortInvoice, type PropertyMaintenance, type RentDue } from './ports'

type Fault = { op: string; mode: 'unreachable' | 'refused'; remaining: number }
export type SynthMail = { sent: { messageId: string; to: string; subject: string; body: string; key: string; at: string }[]; bounce: string[]; faults: Fault[] }
export type SynthCalendar = { busy: BusyInterval[]; events: (CalendarEvent & { description: string })[]; faults: Fault[] }
export type SynthCrm = { nextId: number; contacts: (CrmRecord & { phone: string | null; noteKeys: string[] })[]; faults: Fault[] }
export type SynthInvoicing = { nextId: number; invoices: (PortInvoice & { key: string; lines: { description: string; amount: number }[]; memo: string | null; sentCount: number })[]; faults: Fault[] }
export type SynthProperty = { requests: (PropertyMaintenance & { notes: string[] })[]; rentDue: RentDue[]; faults: Fault[] }
type States = { mail: SynthMail; calendar: SynthCalendar; crm: SynthCrm; invoicing: SynthInvoicing; property_system: SynthProperty }
const EMPTY: { [K in keyof States]: () => States[K] } = {
  mail: () => ({ sent: [], bounce: [], faults: [] }),
  calendar: () => ({ busy: [], events: [], faults: [] }),
  crm: () => ({ nextId: 500, contacts: [], faults: [] }),
  invoicing: () => ({ nextId: 7000, invoices: [], faults: [] }),
  property_system: () => ({ requests: [], rentDue: [], faults: [] }),
}

export async function getSynth<K extends keyof States>(orgId: string, port: K): Promise<States[K]> {
  return admin(async db => ({ ...EMPTY[port](), ...((await db.one<{ state: States[K] }>('select state from pack_synthetic_state where org_id = $1 and port = $2', [orgId, port]))?.state ?? {}) }))
}
export async function mutateSynth<K extends keyof States, T>(orgId: string, port: K, fn: (s: States[K]) => T): Promise<T> {
  return admin(async db => {
    await db.query(`insert into pack_synthetic_state (org_id, port) values ($1, $2) on conflict do nothing`, [orgId, port])
    const row = await db.one<{ state: States[K] }>('select state from pack_synthetic_state where org_id = $1 and port = $2 for update', [orgId, port])
    const s = { ...EMPTY[port](), ...(row?.state ?? {}) } as States[K]
    const out = fn(s)
    await db.query('update pack_synthetic_state set state = $3, updated_at = now() where org_id = $1 and port = $2', [orgId, port, JSON.stringify(s)])
    return out
  })
}
export const resetSynth = (orgId: string) => admin(db => db.query('delete from pack_synthetic_state where org_id = $1', [orgId]))
export const injectPortFault = (orgId: string, port: keyof States, f: { op: string; mode: Fault['mode']; remaining?: number }) =>
  mutateSynth(orgId, port, s => { s.faults.push({ remaining: 1, ...f }) })

async function call<K extends keyof States, T>(orgId: string, port: K, op: string, fn: (s: States[K]) => T): Promise<T> {
  const r = await mutateSynth(orgId, port, s => {
    const f = s.faults.find(x => (x.op === op || x.op === '*') && x.remaining > 0)
    if (f) { f.remaining--; s.faults = s.faults.filter(x => x.remaining > 0); return { fault: f.mode, value: null as T | null, error: null as PortError | null } }
    try { return { fault: null, value: fn(s), error: null } } catch (e) { if (e instanceof PortError) return { fault: null, value: null, error: e }; throw e }
  })
  if (r.fault) throw new PortError(port, r.fault, `${port} ${r.fault === 'unreachable' ? 'did not answer' : 'refused the request'} (synthetic)`)
  if (r.error) throw r.error
  return r.value as T
}
const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const pubContact = (r: SynthCrm['contacts'][number]): CrmRecord => copy({ id: r.id, email: r.email, name: r.name, stage: r.stage, notes: r.notes, tags: r.tags })
const pubInvoice = (x: SynthInvoicing['invoices'][number]): PortInvoice => copy({ id: x.id, number: x.number, customerName: x.customerName, billEmail: x.billEmail, total: x.total, balance: x.balance, dueDate: x.dueDate, currency: x.currency, status: x.status })
const pubRequest = (r: SynthProperty['requests'][number]): PropertyMaintenance => copy({ id: r.id, property: r.property, unit: r.unit, tenantName: r.tenantName, tenantEmail: r.tenantEmail, tenantPhone: r.tenantPhone, description: r.description, category: r.category, status: r.status })

export function syntheticPorts(orgId: string): Ports {
  return {
    mail: {
      provider: 'synthetic',
      send: m => call(orgId, 'mail', 'send', s => {
        const prior = s.sent.find(x => x.key === m.idempotencyKey)
        if (prior) return { messageId: prior.messageId }
        const messageId = `syn-${h(`${orgId}:${m.idempotencyKey}`)}@mail.synthetic.invalid`
        s.sent.push({ messageId, to: m.to.toLowerCase(), subject: m.subject, body: m.body, key: m.idempotencyKey, at: new Date().toISOString() })
        return { messageId }
      }),
      getSent: id => call(orgId, 'mail', 'getSent', s => {
        const m = s.sent.find(x => x.messageId === id)
        return m ? { messageId: m.messageId, to: m.to, subject: m.subject, status: s.bounce.includes(m.to) ? 'bounced' as const : 'sent' as const } : null
      }),
    },
    calendar: {
      provider: 'synthetic',
      freeBusy: ({ timeMin, timeMax }) => call(orgId, 'calendar', 'freeBusy', s => {
        const lo = Date.parse(timeMin), hi = Date.parse(timeMax)
        return [...s.busy, ...s.events.filter(e => e.status !== 'cancelled').map(e => ({ start: e.start, end: e.end }))].filter(b => Date.parse(b.end) > lo && Date.parse(b.start) < hi)
      }),
      insertEvent: e => call(orgId, 'calendar', 'insertEvent', s => {
        const prior = s.events.find(x => x.id === e.id)
        if (prior) return copy(prior)
        const start = new Date(e.start).toISOString(), end = new Date(e.end).toISOString()
        const clash = [...s.busy, ...s.events.filter(x => x.status !== 'cancelled')].some(b => Date.parse(b.start) < Date.parse(end) && Date.parse(b.end) > Date.parse(start))
        if (clash) throw new PortError('calendar', 'refused', 'that time is no longer free (synthetic)')
        const ev = { id: e.id, status: 'confirmed' as const, summary: e.summary, description: e.description, start, end, attendees: e.attendees.map(a => a.toLowerCase()), meetLink: null, htmlLink: `https://calendar.synthetic.invalid/event/${e.id}` }
        s.events.push(ev)
        return copy(ev)
      }),
      getEvent: id => call(orgId, 'calendar', 'getEvent', s => copy(s.events.find(e => e.id === id) ?? null)),
    },
    crm: {
      provider: 'synthetic',
      upsertContact: c => call(orgId, 'crm', 'upsertContact', s => {
        const email = c.email.toLowerCase()
        let r = s.contacts.find(x => x.email === email)
        if (!r) { r = { id: String(s.nextId++), email, name: c.name, phone: c.phone, stage: c.stage, notes: [], tags: [], noteKeys: [] }; s.contacts.push(r) }
        r.tags = [...new Set([...r.tags, ...c.tags])]
        if (!r.stage) r.stage = c.stage
        return pubContact(r)
      }),
      addNote: (id, note, key) => call(orgId, 'crm', 'addNote', s => {
        const r = s.contacts.find(x => x.id === id)
        if (!r) throw new PortError('crm', 'not_found', 'no such contact (synthetic)')
        const at = r.noteKeys.indexOf(key)
        if (at >= 0) return { id: `${id}:n${at}` }
        r.notes.push(note); r.noteKeys.push(key)
        return { id: `${id}:n${r.notes.length - 1}` }
      }),
      setStage: (id, stage) => call(orgId, 'crm', 'setStage', s => {
        const r = s.contacts.find(x => x.id === id)
        if (!r) throw new PortError('crm', 'not_found', 'no such contact (synthetic)')
        r.stage = stage
        return pubContact(r)
      }),
      getContact: id => call(orgId, 'crm', 'getContact', s => { const r = s.contacts.find(x => x.id === id); return r ? pubContact(r) : null }),
    },
    invoicing: {
      provider: 'synthetic',
      createInvoice: i => call(orgId, 'invoicing', 'createInvoice', s => {
        const prior = s.invoices.find(x => x.key === i.idempotencyKey)
        if (prior) return pubInvoice(prior)
        const total = Math.round(i.lines.reduce((a, l) => a + l.amount, 0) * 100) / 100
        const id = String(s.nextId++)
        const inv = { id, number: `INV-${id}`, customerName: i.customerName, billEmail: i.billEmail, total, balance: total, dueDate: i.dueDate, currency: i.currency, status: 'open' as const, key: i.idempotencyKey, lines: i.lines, memo: i.memo ?? null, sentCount: 0 }
        s.invoices.push(inv)
        return pubInvoice(inv)
      }),
      getInvoice: id => call(orgId, 'invoicing', 'getInvoice', s => { const x = s.invoices.find(i => i.id === id); return x ? pubInvoice(x) : null }),
      sendInvoice: id => call(orgId, 'invoicing', 'sendInvoice', s => { const x = s.invoices.find(i => i.id === id); if (!x) throw new PortError('invoicing', 'not_found', 'no such invoice (synthetic)'); x.sentCount++; return { sent: true } }),
    },
    propertySystem: {
      provider: 'synthetic',
      getMaintenanceRequest: id => call(orgId, 'property_system', 'getMaintenanceRequest', s => { const r = s.requests.find(x => x.id === id); return r ? pubRequest(r) : null }),
      updateMaintenanceStatus: (id, status, note) => call(orgId, 'property_system', 'updateMaintenanceStatus', s => {
        const r = s.requests.find(x => x.id === id)
        if (!r) throw new PortError('property_system', 'not_found', 'no such request (synthetic)')
        if (r.status !== status) { r.status = status; r.notes.push(note) }
        return pubRequest(r)
      }),
      listRentDue: asOf => call(orgId, 'property_system', 'listRentDue', s => copy(s.rentDue.filter(r => r.dueDate <= asOf && r.amountDue > 0))),
    },
  }
}

/** Synthetic QuickBooks payment: reduce an invoice's balance (partial or full). */
export const synthPay = (orgId: string, invoiceId: string, amount: number) => mutateSynth(orgId, 'invoicing', s => {
  const x = s.invoices.find(i => i.id === invoiceId)
  if (!x) throw new Error('no such synthetic invoice')
  x.balance = Math.max(0, Math.round((x.balance - amount) * 100) / 100)
  if (x.balance === 0) x.status = 'paid'
})

setSyntheticPorts(syntheticPorts)
