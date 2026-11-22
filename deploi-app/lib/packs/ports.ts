/**
 * The small provider contracts the pack agents are written against. Every agent reads and writes the outside
 * world ONLY through these ports, so the provider clients built separately (Outlook mail and calendar, the CRMs,
 * Buildium, QuickBooks writes) plug in by implementing them and calling setPortsFactory(). Until then every port
 * is the synthetic adapter in lib/packs/synthetic.ts (stateful, inside Deploi, nothing leaves the machine).
 *
 * Rules every implementation keeps:
 *  - writes are idempotent on the key the agent passes (a repeat call returns the first result, never a second record);
 *  - reads are fresh reads of the provider (they are what an agent's verify step trusts);
 *  - a provider refusal is thrown as PortError with a plain reason; agents report it to the owner, never retry blindly.
 */
import type { BusyInterval, CalendarEvent, NewEvent } from '../office/types'

export class PortError extends Error {
  constructor(public port: string, public code: 'unreachable' | 'refused' | 'not_found' | 'invalid', message: string) { super(message); this.name = 'PortError' }
}

/** Outgoing mail (Outlook / Gmail / the agent mailbox). */
export interface MailPort {
  readonly provider: string
  /** idempotent on idempotencyKey */
  send(m: { to: string; subject: string; body: string; idempotencyKey: string; replyToMessageId?: string | null }): Promise<{ messageId: string }>
  /** fresh read of a sent message (verify step); null when the provider has no such message */
  getSent(messageId: string): Promise<{ messageId: string; to: string; subject: string; status: 'sent' | 'bounced' } | null>
}

/** The calendar a business books visits, tours and showings on (the Office calendar shape). */
export interface CalendarPort {
  readonly provider: string
  freeBusy(input: { timeMin: string; timeMax: string; timeZone: string }): Promise<BusyInterval[]>
  insertEvent(e: NewEvent): Promise<CalendarEvent>
  getEvent(id: string): Promise<CalendarEvent | null>
}

export type CrmRecord = { id: string; email: string | null; name: string | null; stage: string | null; notes: string[]; tags: string[] }
/** The CRM a real estate agent (or any pack) keeps contacts in (Follow Up Boss, kvCORE, HubSpot ...). */
export interface CrmPort {
  readonly provider: string
  /** find by email, or create; idempotent on email */
  upsertContact(c: { email: string; name: string | null; phone: string | null; stage: string; tags: string[] }): Promise<CrmRecord>
  /** idempotent on idempotencyKey */
  addNote(contactId: string, note: string, idempotencyKey: string): Promise<{ id: string }>
  setStage(contactId: string, stage: string): Promise<CrmRecord>
  getContact(id: string): Promise<CrmRecord | null>
}

export type InvoiceLine = { description: string; amount: number }
export type PortInvoice = { id: string; number: string; customerName: string | null; billEmail: string | null; total: number; balance: number; dueDate: string; currency: string; status: 'open' | 'paid' | 'void' }
/** Invoicing writes and reads (QuickBooks Online). */
export interface InvoicingPort {
  readonly provider: string
  /** idempotent on idempotencyKey: a repeat returns the invoice created the first time */
  createInvoice(i: { customerName: string; billEmail: string | null; lines: InvoiceLine[]; dueDate: string; currency: string; idempotencyKey: string; memo?: string }): Promise<PortInvoice>
  getInvoice(id: string): Promise<PortInvoice | null>
  /** ask the provider to email the invoice to its billing address */
  sendInvoice(id: string): Promise<{ sent: boolean }>
}

export type PropertyMaintenance = { id: string; property: string | null; unit: string | null; tenantName: string | null; tenantEmail: string | null; tenantPhone: string | null; description: string; category: string | null; status: string }
export type RentDue = { tenantId: string; tenantName: string | null; tenantEmail: string | null; property: string | null; unit: string | null; amountDue: number; dueDate: string; currency: string }
/** The property system (Buildium, AppFolio ...). */
export interface PropertySystemPort {
  readonly provider: string
  getMaintenanceRequest(id: string): Promise<PropertyMaintenance | null>
  /** idempotent: setting the same status twice is a no-op */
  updateMaintenanceStatus(id: string, status: 'assigned' | 'in_progress' | 'completed', note: string): Promise<PropertyMaintenance>
  listRentDue(asOf: string): Promise<RentDue[]>
}

export type Ports = { mail: MailPort; calendar: CalendarPort; crm: CrmPort; invoicing: InvoicingPort; propertySystem: PropertySystemPort }
export type PortsFactory = (orgId: string) => Promise<Partial<Ports>>

let factory: PortsFactory | null = null
let fallback: ((orgId: string) => Ports) | null = null
/** The lead installs the real clients here; any port it does not return stays synthetic. */
export function setPortsFactory(f: PortsFactory | null) { factory = f }
/** lib/packs/synthetic.ts installs the synthetic adapters (kept separate so this file has no database code). */
export function setSyntheticPorts(f: (orgId: string) => Ports) { fallback = f }

export async function portsFor(orgId: string): Promise<Ports & { synthetic: (keyof Ports)[] }> {
  if (!fallback) throw new Error('synthetic ports are not installed (import lib/packs)')
  const syn = fallback(orgId)
  const real = factory ? await factory(orgId) : {}
  const keys = Object.keys(syn) as (keyof Ports)[]
  const out = { ...syn, ...real } as Ports
  return { ...out, synthetic: keys.filter(k => !real[k]) }
}
