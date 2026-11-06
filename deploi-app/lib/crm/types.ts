/**
 * One CRM contract for every agent pack: HubSpot, Salesforce, Pipedrive and Zoho CRM all answer the same calls,
 * so a pack finds a person, creates or updates them, logs a task or a note and moves a deal the same way
 * whichever CRM the business uses. Provider-specific reads and writes stay on each provider's own client.
 */
import type { CrmProvider } from '../office/config'

export type { CrmProvider }

/** A person in the CRM. `kind` says which record type holds them (Salesforce and Zoho keep leads apart from contacts). */
export type CrmContact = {
  id: string
  kind: 'lead' | 'contact'
  email: string | null
  firstName: string | null
  lastName: string | null
  phone: string | null
  company: string | null
  updatedAt: string | null
}

export type UpsertContactInput = {
  email: string
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
  company?: string | null
  /** where the person came from (e.g. "Zillow"), written to the provider's lead source field where it has one */
  source?: string | null
}

export interface CrmClient {
  readonly provider: CrmProvider
  /** exact email match (any case); contacts are preferred over unconverted leads */
  findContactByEmail(email: string): Promise<CrmContact | null>
  /** update the person with that email, or create them (as a lead where the CRM has leads) */
  upsertContact(input: UpsertContactInput): Promise<{ contact: CrmContact; created: boolean }>
  /** a to-do on the person (HubSpot task, Salesforce Task, Pipedrive activity, Zoho Task) */
  createTask(input: { contact: Pick<CrmContact, 'id' | 'kind'>; subject: string; body?: string; dueAt: Date }): Promise<{ id: string }>
  addNote(input: { contact: Pick<CrmContact, 'id' | 'kind'>; body: string }): Promise<{ id: string }>
  /** the provider's own stage id or name (HubSpot dealstage, Salesforce StageName, Pipedrive stage_id, Zoho Stage) */
  updateDealStage(dealId: string, stage: string): Promise<{ id: string; stage: string | null }>
  /** people created or changed since `since`, oldest first, for change detection */
  listChangedContacts(input: { since: Date; page?: string | null; limit?: number }): Promise<{ contacts: CrmContact[]; next: string | null }>
}

const clean = (v: unknown, n = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
export const crmText = clean
export const crmEmail = (v: unknown) => { const e = clean(v, 254)?.toLowerCase() ?? null; return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null }
export const assertEmail = (v: string) => { const e = crmEmail(v); if (!e) throw new Error('not an email address'); return e }
