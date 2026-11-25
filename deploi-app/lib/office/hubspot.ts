/**
 * HubSpot CRM (OAuth 2.0 + CRM v3 objects API). Read leads (contacts in lifecycle stage "lead"), read and
 * update one contact, log notes and tasks associated with a contact, move a deal stage. HubSpot's OAuth
 * flow takes no PKCE parameters; the one-time state, bound to the organization and the user, protects
 * the callback. Not live-verified: see docs/OFFICE-SETUP.md.
 */
import { officeConfig } from './config'
import { OfficeHttpError, officeRequest, tokenPost } from './http'
import type { HubSpotApi, HubSpotContact } from './types'

export const HUBSPOT_AUTHORIZE = 'https://app.hubspot.com/oauth/authorize'
export const HUBSPOT_TOKEN = 'https://api.hubapi.com/oauth/v1/token'
const API = 'https://api.hubapi.com'
/** Required scopes. Notes and tasks are CRM engagement objects associated with contacts; HubSpot covers them with the contact scopes. */
export const HUBSPOT_SCOPES = ['crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.deals.read', 'crm.objects.deals.write'] as const
/** HubSpot-defined association types (v4): note to contact, task to contact */
export const NOTE_TO_CONTACT = 202
export const TASK_TO_CONTACT = 204
const CONTACT_PROPS = ['email', 'firstname', 'lastname', 'company', 'lifecyclestage', 'hs_email_optout', 'createdate', 'lastmodifieddate']

export function hubspotAuthorizeUrl(state: string): string {
  const q = new URLSearchParams({ client_id: officeConfig.hubspotClientId, redirect_uri: officeConfig.hubspotRedirectUrl, scope: HUBSPOT_SCOPES.join(' '), state })
  return `${HUBSPOT_AUTHORIZE}?${q}`
}

export type OAuthTokens = { accessToken: string; refreshToken: string | null; expiresIn: number | null; scopes: string[] }

function tokenSet(j: Record<string, unknown>, fallback: string[]): OAuthTokens {
  return {
    accessToken: String(j.access_token ?? ''),
    refreshToken: j.refresh_token ? String(j.refresh_token) : null,
    expiresIn: typeof j.expires_in === 'number' ? j.expires_in : null,
    scopes: typeof j.scope === 'string' ? j.scope.split(/[ ,]+/).filter(Boolean) : fallback,
  }
}

export async function hubspotExchange(code: string): Promise<OAuthTokens> {
  const r = await tokenPost('hubspot', HUBSPOT_TOKEN, { grant_type: 'authorization_code', client_id: officeConfig.hubspotClientId, client_secret: officeConfig.hubspotClientSecret, redirect_uri: officeConfig.hubspotRedirectUrl, code })
  if (r.status !== 200 || !r.json.access_token) throw new Error(`HubSpot token exchange failed (${String(r.json.error ?? r.status).slice(0, 40)})`)
  return tokenSet(r.json, [...HUBSPOT_SCOPES])
}

export async function hubspotRefresh(refreshToken: string, scopes: string[]): Promise<OAuthTokens> {
  const r = await tokenPost('hubspot', HUBSPOT_TOKEN, { grant_type: 'refresh_token', client_id: officeConfig.hubspotClientId, client_secret: officeConfig.hubspotClientSecret, redirect_uri: officeConfig.hubspotRedirectUrl, refresh_token: refreshToken })
  if (r.status !== 200 || !r.json.access_token) throw Object.assign(new Error(`HubSpot token refresh failed (${String(r.json.error ?? r.status).slice(0, 40)})`), { auth: r.status === 400 || r.status === 401 })
  const t = tokenSet(r.json, scopes)
  return { ...t, refreshToken: t.refreshToken ?? refreshToken }
}

/** Revoke on disconnect: deletes the refresh token at HubSpot (the app's grant for that portal ends). Best effort. */
export async function hubspotRevoke(refreshToken: string): Promise<boolean> {
  try { const r = await officeRequest('hubspot', `${API}/oauth/v1/refresh-tokens/${encodeURIComponent(refreshToken)}`, { method: 'DELETE' }); return r.status === 204 || r.status === 200 } catch { return false }
}

/** The portal (hub) the token belongs to, and its granted scopes. */
export async function hubspotIdentity(accessToken: string): Promise<{ hubId: string; user: string | null; hubDomain: string | null; scopes: string[] }> {
  const r = await officeRequest<{ hub_id?: number; user?: string; hub_domain?: string; scopes?: string[] }>('hubspot', `${API}/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`)
  if (!r.body.hub_id) throw new Error('HubSpot did not return the portal id')
  return { hubId: String(r.body.hub_id), user: r.body.user ?? null, hubDomain: r.body.hub_domain ?? null, scopes: r.body.scopes ?? [] }
}

type Obj = { id: string; properties?: Record<string, string | null>; createdAt?: string; updatedAt?: string }

export function toContact(o: Obj): HubSpotContact {
  const p = o.properties ?? {}
  return {
    id: String(o.id), email: p.email ? p.email.trim().toLowerCase() : null, firstName: p.firstname ?? null, lastName: p.lastname ?? null, company: p.company ?? null,
    lifecycleStage: p.lifecyclestage ?? null, optedOut: p.hs_email_optout === 'true', createdAt: p.createdate ?? o.createdAt ?? null, updatedAt: p.lastmodifieddate ?? o.updatedAt ?? null,
  }
}

/** HubSpot object ids are numeric strings; anything else is refused before it reaches a URL. */
const objId = (id: string) => { if (!/^\d{1,20}$/.test(id)) throw new OfficeHttpError(400, 'invalid', 'not a HubSpot object id', 'hubspot'); return id }

export function hubspotClient(token: () => Promise<string>): HubSpotApi {
  const call = async <T>(path: string, init: RequestInit & { json?: unknown } = {}) => {
    const t = await token()
    return (await officeRequest<T>('hubspot', `${API}${path}`, { ...init, headers: { authorization: `Bearer ${t}` } })).body
  }
  const get = async <T>(path: string): Promise<T | null> => {
    try { return await call<T>(path) } catch (e) { if (e instanceof OfficeHttpError && e.code === 'not_found') return null; throw e }
  }
  const searchMarker = async (object: 'notes' | 'tasks', property: string, marker: string) => {
    const r = await call<{ results?: Obj[] }>(`/crm/v3/objects/${object}/search`, { method: 'POST', json: { filterGroups: [{ filters: [{ propertyName: property, operator: 'CONTAINS_TOKEN', value: marker }] }], properties: [property], limit: 1 } })
    return r.results?.[0] ? { id: String(r.results[0].id) } : null
  }
  return {
    async searchLeads({ since, after, limit }) {
      const r = await call<{ results?: Obj[]; paging?: { next?: { after?: string } } }>('/crm/v3/objects/contacts/search', {
        method: 'POST',
        json: {
          filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'lead' }, { propertyName: 'lastmodifieddate', operator: 'GTE', value: String(since.getTime()) }] }],
          sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
          properties: CONTACT_PROPS, limit: Math.min(Math.max(limit, 1), 100), ...(after ? { after } : {}),
        },
      })
      return { contacts: (r.results ?? []).map(toContact), next: r.paging?.next?.after ?? null }
    },
    async getContact(id) {
      const o = await get<Obj>(`/crm/v3/objects/contacts/${objId(id)}?properties=${CONTACT_PROPS.join(',')}`)
      return o ? toContact(o) : null
    },
    async updateContact(id, properties) {
      return toContact(await call<Obj>(`/crm/v3/objects/contacts/${objId(id)}`, { method: 'PATCH', json: { properties } }))
    },
    async createNote({ contactId, body, timestamp }) {
      const o = await call<Obj>('/crm/v3/objects/notes', { method: 'POST', json: { properties: { hs_timestamp: timestamp.toISOString(), hs_note_body: body },
        associations: [{ to: { id: objId(contactId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }] }] } })
      return { id: String(o.id) }
    },
    async getNote(id) {
      const o = await get<Obj>(`/crm/v3/objects/notes/${objId(id)}?properties=hs_note_body`)
      return o ? { id: String(o.id), body: o.properties?.hs_note_body ?? '' } : null
    },
    findNoteByMarker: marker => searchMarker('notes', 'hs_note_body', marker),
    async createTask({ contactId, subject, body, dueAt }) {
      const o = await call<Obj>('/crm/v3/objects/tasks', { method: 'POST', json: { properties: { hs_timestamp: dueAt.toISOString(), hs_task_subject: subject, hs_task_body: body, hs_task_status: 'NOT_STARTED', hs_task_priority: 'MEDIUM', hs_task_type: 'TODO' },
        associations: [{ to: { id: objId(contactId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TASK_TO_CONTACT }] }] } })
      return { id: String(o.id) }
    },
    async getTask(id) {
      const o = await get<Obj>(`/crm/v3/objects/tasks/${objId(id)}?properties=hs_task_body`)
      return o ? { id: String(o.id), body: o.properties?.hs_task_body ?? '' } : null
    },
    findTaskByMarker: marker => searchMarker('tasks', 'hs_task_body', marker),
    async listContactDeals(contactId) {
      const r = await get<{ results?: { toObjectId: number | string }[] }>(`/crm/v4/objects/contacts/${objId(contactId)}/associations/deals?limit=100`)
      return (r?.results ?? []).map(x => String(x.toObjectId))
    },
    async getDeal(id) {
      const o = await get<Obj>(`/crm/v3/objects/deals/${objId(id)}?properties=dealstage`)
      return o ? { id: String(o.id), stage: o.properties?.dealstage ?? null } : null
    },
    async updateDealStage(id, stage) {
      const o = await call<Obj>(`/crm/v3/objects/deals/${objId(id)}`, { method: 'PATCH', json: { properties: { dealstage: stage } } })
      return { id: String(o.id), stage: o.properties?.dealstage ?? null }
    },
  }
}
