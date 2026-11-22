/**
 * HubSpot behind the common CRM contract (lib/crm/types.ts). Notes, tasks and deal stages reuse the HubSpot client
 * the Office agents already use; finding, creating and listing contacts are CRM v3 object calls. A 401 refreshes the
 * token once and repeats the call. Not live-verified: tested against a fake HTTP layer only.
 */
import { OfficeHttpError, officeRequest } from '../office/http'
import { hubspotClient, toContact } from '../office/hubspot'
import { withOfficeToken, type TokenSource } from '../office/token'
import { assertEmail, type CrmClient, type CrmContact } from './types'
import type { HubSpotContact } from '../office/types'

const API = 'https://api.hubapi.com'
const PROPS = ['email', 'firstname', 'lastname', 'phone', 'company', 'lifecyclestage', 'hs_email_optout', 'createdate', 'lastmodifieddate']
type Obj = { id: string; properties?: Record<string, string | null> }

const asCrm = (c: HubSpotContact, phone: string | null = null): CrmContact => ({ id: c.id, kind: c.lifecycleStage === 'lead' ? 'lead' : 'contact', email: c.email, firstName: c.firstName, lastName: c.lastName, phone, company: c.company, updatedAt: c.updatedAt })
const fromObj = (o: Obj) => asCrm(toContact(o), o.properties?.phone ?? null)

export function hubspotCrm(tokens: TokenSource): CrmClient {
  const call = <T>(path: string, init: RequestInit & { json?: unknown } = {}) =>
    withOfficeToken(tokens, async t => (await officeRequest<T>('hubspot', `${API}${path}`, { ...init, headers: { authorization: `Bearer ${t}` } })).body)
  // the existing client (notes, tasks, deal stage) with the same refresh-once behaviour
  let current: string | null = null
  const legacy = hubspotClient(async () => (current ??= await tokens.get()))
  const viaLegacy = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn() } catch (e) {
      if (!(e instanceof OfficeHttpError) || e.code !== 'auth' || !current) throw e
      current = await tokens.refresh(current)
      return fn()
    }
  }
  const self: CrmClient = {
    provider: 'hubspot',
    async findContactByEmail(email) {
      const r = await call<{ results?: Obj[] }>('/crm/v3/objects/contacts/search', { method: 'POST', json: { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: assertEmail(email) }] }], properties: PROPS, limit: 1 } })
      return r.results?.[0] ? fromObj(r.results[0]) : null
    },
    async upsertContact(i) {
      const email = assertEmail(i.email)
      const props: Record<string, string> = {}
      if (i.firstName) props.firstname = i.firstName.slice(0, 100)
      if (i.lastName) props.lastname = i.lastName.slice(0, 100)
      if (i.phone) props.phone = i.phone.slice(0, 40)
      if (i.company) props.company = i.company.slice(0, 200)
      const found = await self.findContactByEmail(email)
      if (found) {
        if (!Object.keys(props).length) return { contact: found, created: false }
        return { contact: fromObj(await call<Obj>(`/crm/v3/objects/contacts/${found.id}`, { method: 'PATCH', json: { properties: props } })), created: false }
      }
      const o = await call<Obj>('/crm/v3/objects/contacts', { method: 'POST', json: { properties: { ...props, email, lifecyclestage: 'lead', ...(i.source ? { hs_lead_status: 'NEW' } : {}) } } })
      return { contact: fromObj(o), created: true }
    },
    createTask: ({ contact, subject, body, dueAt }) => viaLegacy(() => legacy.createTask({ contactId: contact.id, subject, body: body ?? '', dueAt })),
    addNote: ({ contact, body }) => viaLegacy(() => legacy.createNote({ contactId: contact.id, body, timestamp: new Date() })),
    updateDealStage: (dealId, stage) => viaLegacy(() => legacy.updateDealStage(dealId, stage)),
    async listChangedContacts({ since, page, limit }) {
      const r = await call<{ results?: Obj[]; paging?: { next?: { after?: string } } }>('/crm/v3/objects/contacts/search', { method: 'POST', json: {
        filterGroups: [{ filters: [{ propertyName: 'lastmodifieddate', operator: 'GT', value: String(since.getTime()) }] }], sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
        properties: PROPS, limit: Math.min(Math.max(limit ?? 100, 1), 100), ...(page ? { after: page } : {}) } })
      return { contacts: (r.results ?? []).map(fromObj), next: r.paging?.next?.after ?? null }
    },
  }
  return self
}
