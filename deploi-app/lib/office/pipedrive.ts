/**
 * Pipedrive (Marketplace app; OAuth 2.0 authorization code, API v2 for persons, deals and activities, v1 for notes).
 *  - Consent: https://oauth.pipedrive.com/oauth/authorize (the scopes are chosen on the app in Developer Hub, not in
 *    the URL; Deploi needs contacts:full, deals:full, activities:full and users:read).
 *  - Token / refresh: https://oauth.pipedrive.com/oauth/token with HTTP Basic client credentials. The answer carries
 *    api_domain (https://<company>.pipedrive.com): every API call goes there (stored as the connection's api_base and
 *    re-checked against *.pipedrive.com). Access tokens last about an hour; a refresh may return a new refresh token,
 *    and the newest one is stored.
 *  - Revoke: https://oauth.pipedrive.com/oauth/revoke (refresh token).
 * Sources: pipedrive.readme.io/docs/marketplace-oauth-authorization, developers.pipedrive.com/docs/api/v1.
 * Not live-verified: tested against a fake HTTP layer only.
 */
import { officeConfig } from './config'
import { OfficeHttpError, officeRequest, tokenPost } from './http'
import type { OAuthTokens } from './hubspot'
import { httpsOrigin, parseTokens, tokenError } from './oauth'
import { withOfficeToken, type TokenSource } from './token'
import { assertEmail, crmEmail, crmText, type CrmClient, type CrmContact } from '../crm/types'
import { assertApprovedHost } from '../net/outbound'

export const PIPEDRIVE_AUTHORIZE = 'https://oauth.pipedrive.com/oauth/authorize'
export const PIPEDRIVE_TOKEN = 'https://oauth.pipedrive.com/oauth/token'
export const PIPEDRIVE_REVOKE = 'https://oauth.pipedrive.com/oauth/revoke'
/** set on the app in Pipedrive Developer Hub; listed here so the integration hub can explain them */
export const PIPEDRIVE_SCOPES = ['contacts:full', 'deals:full', 'activities:full', 'users:read'] as const

export function pipedriveAuthorizeUrl(state: string): string {
  return `${PIPEDRIVE_AUTHORIZE}?${new URLSearchParams({ client_id: officeConfig.pipedriveClientId, redirect_uri: officeConfig.pipedriveRedirectUrl, state })}`
}
const basic = () => `Basic ${Buffer.from(`${officeConfig.pipedriveClientId}:${officeConfig.pipedriveClientSecret}`).toString('base64')}`

export function pipedriveDomain(v: unknown): string {
  const o = httpsOrigin(v)
  if (!o) throw new OfficeHttpError(400, 'invalid', 'Pipedrive did not return the company domain', 'pipedrive')
  assertApprovedHost(`${o}/`, 'pipedrive')
  return o
}

export type PipedriveGrant = OAuthTokens & { apiDomain: string }

export async function pipedriveExchange(code: string): Promise<PipedriveGrant> {
  const r = await tokenPost('pipedrive', PIPEDRIVE_TOKEN, { grant_type: 'authorization_code', code, redirect_uri: officeConfig.pipedriveRedirectUrl }, { authorization: basic() })
  if (r.status !== 200 || !r.json.access_token) throw tokenError('Pipedrive', 'exchange', r.status, r.json)
  return { ...parseTokens(r.json, [...PIPEDRIVE_SCOPES]), apiDomain: pipedriveDomain(r.json.api_domain) }
}

export async function pipedriveRefresh(refreshToken: string, scopes: string[]): Promise<OAuthTokens & { apiBase: string | null }> {
  const r = await tokenPost('pipedrive', PIPEDRIVE_TOKEN, { grant_type: 'refresh_token', refresh_token: refreshToken }, { authorization: basic() })
  if (r.status !== 200 || !r.json.access_token) throw tokenError('Pipedrive', 'refresh', r.status, r.json)
  const t = parseTokens(r.json, scopes)
  return { ...t, refreshToken: t.refreshToken ?? refreshToken, apiBase: r.json.api_domain ? pipedriveDomain(r.json.api_domain) : null }
}

export async function pipedriveRevoke(refreshToken: string): Promise<boolean> {
  try { const r = await tokenPost('pipedrive', PIPEDRIVE_REVOKE, { token: refreshToken, token_type_hint: 'refresh_token' }, { authorization: basic() }); return r.status === 200 } catch { return false }
}

const pdId = (id: string | number) => { const s = String(id); if (!/^\d{1,15}$/.test(s)) throw new OfficeHttpError(400, 'invalid', 'not a Pipedrive id', 'pipedrive'); return s }

type PdPerson = { id?: number; name?: string; first_name?: string; last_name?: string; emails?: { value?: string; primary?: boolean }[]; phones?: { value?: string; primary?: boolean }[]
  email?: { value?: string; primary?: boolean }[]; phone?: { value?: string; primary?: boolean }[]; org_name?: string; organization?: { name?: string } | null; update_time?: string }
const primary = (xs: { value?: string; primary?: boolean }[] | undefined) => (xs ?? []).find(x => x.primary)?.value ?? xs?.[0]?.value

export function toPdContact(p: PdPerson): CrmContact {
  return { id: String(p.id ?? ''), kind: 'contact', email: crmEmail(primary(p.emails ?? p.email)), firstName: crmText(p.first_name, 80), lastName: crmText(p.last_name, 80),
    phone: crmText(primary(p.phones ?? p.phone), 40), company: crmText(p.org_name ?? p.organization?.name, 255), updatedAt: crmText(p.update_time, 40) }
}

type Envelope<T> = { success?: boolean; data?: T; additional_data?: { next_cursor?: string | null } }

export interface PipedriveApi extends CrmClient {
  me(): Promise<{ companyId: string; companyName: string | null; userId: string }>
  getPerson(id: string): Promise<CrmContact | null>
  listDeals(o: { personId?: string; cursor?: string | null; limit?: number }): Promise<{ deals: { id: string; title: string | null; stageId: string | null; status: string | null }[]; next: string | null }>
  createDeal(d: { title: string; personId?: string; stageId?: string; value?: number; currency?: string }): Promise<{ id: string }>
  listActivities(o: { personId?: string; cursor?: string | null; limit?: number }): Promise<{ activities: { id: string; subject: string | null; done: boolean; dueDate: string | null }[]; next: string | null }>
  completeActivity(id: string): Promise<void>
}

export function pipedriveClient(tokens: TokenSource, apiDomain: string): PipedriveApi {
  const base = pipedriveDomain(apiDomain)
  const call = <T>(path: string, init: RequestInit & { json?: unknown; retryServer?: boolean } = {}) =>
    withOfficeToken(tokens, async t => (await officeRequest<Envelope<T>>('pipedrive', `${base}${path}`, { ...init, headers: { authorization: `Bearer ${t}` } })).body)
  const page = (o: { cursor?: string | null; limit?: number }, extra: Record<string, string> = {}) =>
    new URLSearchParams({ limit: String(Math.min(Math.max(o.limit ?? 100, 1), 500)), ...(o.cursor ? { cursor: o.cursor } : {}), ...extra })
  const self: PipedriveApi = {
    provider: 'pipedrive',
    async me() {
      const r = await call<{ id?: number; company_id?: number; company_name?: string }>('/api/v1/users/me', { retryServer: true })
      if (!r.data?.company_id) throw new OfficeHttpError(200, 'server', 'Pipedrive did not return the company id', 'pipedrive')
      return { companyId: String(r.data.company_id), companyName: crmText(r.data.company_name, 120), userId: String(r.data.id ?? '') }
    },
    async getPerson(id) {
      try { const r = await call<PdPerson>(`/api/v2/persons/${pdId(id)}`, { retryServer: true }); return r.data ? toPdContact(r.data) : null } catch (e) { if (e instanceof OfficeHttpError && e.code === 'not_found') return null; throw e }
    },
    async findContactByEmail(email) {
      const q = new URLSearchParams({ term: assertEmail(email), fields: 'email', exact_match: 'true', limit: '1' })
      const r = await call<{ items?: { item?: { id?: number } }[] }>(`/api/v2/persons/search?${q}`, { retryServer: true })
      const id = r.data?.items?.[0]?.item?.id
      return id ? self.getPerson(String(id)) : null
    },
    async upsertContact(i) {
      const email = assertEmail(i.email)
      const found = await self.findContactByEmail(email)
      const name = [i.firstName, i.lastName].filter(Boolean).join(' ') || email.split('@')[0]
      const fields: Record<string, unknown> = {}
      if (i.firstName || i.lastName) fields.name = name.slice(0, 255)
      if (i.phone) fields.phones = [{ value: i.phone.slice(0, 40), primary: true, label: 'work' }]
      if (found) {
        if (Object.keys(fields).length) await call(`/api/v2/persons/${pdId(found.id)}`, { method: 'PATCH', json: fields })
        return { contact: { ...found, firstName: i.firstName ?? found.firstName, lastName: i.lastName ?? found.lastName, phone: i.phone ?? found.phone }, created: false }
      }
      const r = await call<PdPerson>('/api/v2/persons', { method: 'POST', json: { name: name.slice(0, 255), emails: [{ value: email, primary: true, label: 'work' }], ...fields } })
      if (!r.data?.id) throw new OfficeHttpError(200, 'server', 'Pipedrive did not return the new person id', 'pipedrive')
      return { contact: { ...toPdContact(r.data), email }, created: true }
    },
    async createTask({ contact, subject, body, dueAt }) {
      const r = await call<{ id?: number }>('/api/v2/activities', { method: 'POST', json: { subject: subject.slice(0, 255), type: 'task', due_date: dueAt.toISOString().slice(0, 10),
        participants: [{ person_id: Number(pdId(contact.id)), primary: true }], ...(body ? { note: body.slice(0, 10000) } : {}) } })
      if (!r.data?.id) throw new OfficeHttpError(200, 'server', 'Pipedrive did not return the new activity id', 'pipedrive')
      return { id: String(r.data.id) }
    },
    async addNote({ contact, body }) {
      const r = await call<{ id?: number }>('/api/v1/notes', { method: 'POST', json: { content: body.slice(0, 50000), person_id: Number(pdId(contact.id)) } })
      if (!r.data?.id) throw new OfficeHttpError(200, 'server', 'Pipedrive did not return the new note id', 'pipedrive')
      return { id: String(r.data.id) }
    },
    async updateDealStage(dealId, stage) {
      const r = await call<{ id?: number; stage_id?: number }>(`/api/v2/deals/${pdId(dealId)}`, { method: 'PATCH', json: { stage_id: Number(pdId(stage)) } })
      return { id: dealId, stage: r.data?.stage_id !== undefined ? String(r.data.stage_id) : null }
    },
    async listChangedContacts({ since, page: cursor, limit }) {
      const r = await call<PdPerson[]>(`/api/v2/persons?${page({ cursor, limit }, { updated_since: since.toISOString().replace(/\.\d{3}Z$/, 'Z'), sort_by: 'update_time', sort_direction: 'asc' })}`, { retryServer: true })
      return { contacts: (r.data ?? []).map(toPdContact), next: r.additional_data?.next_cursor ?? null }
    },
    async listDeals(o) {
      const r = await call<{ id?: number; title?: string; stage_id?: number; status?: string }[]>(`/api/v2/deals?${page(o, o.personId ? { person_id: pdId(o.personId) } : {})}`, { retryServer: true })
      return { deals: (r.data ?? []).map(d => ({ id: String(d.id), title: crmText(d.title), stageId: d.stage_id !== undefined ? String(d.stage_id) : null, status: crmText(d.status, 20) })), next: r.additional_data?.next_cursor ?? null }
    },
    async createDeal(d) {
      const r = await call<{ id?: number }>('/api/v2/deals', { method: 'POST', json: { title: d.title.slice(0, 255), ...(d.personId ? { person_id: Number(pdId(d.personId)) } : {}), ...(d.stageId ? { stage_id: Number(pdId(d.stageId)) } : {}),
        ...(d.value !== undefined ? { value: d.value } : {}), ...(d.currency ? { currency: d.currency.slice(0, 3).toUpperCase() } : {}) } })
      if (!r.data?.id) throw new OfficeHttpError(200, 'server', 'Pipedrive did not return the new deal id', 'pipedrive')
      return { id: String(r.data.id) }
    },
    async listActivities(o) {
      const r = await call<{ id?: number; subject?: string; done?: boolean; due_date?: string }[]>(`/api/v2/activities?${page(o, o.personId ? { person_id: pdId(o.personId) } : {})}`, { retryServer: true })
      return { activities: (r.data ?? []).map(a => ({ id: String(a.id), subject: crmText(a.subject), done: Boolean(a.done), dueDate: crmText(a.due_date, 10) })), next: r.additional_data?.next_cursor ?? null }
    },
    async completeActivity(id) { await call(`/api/v2/activities/${pdId(id)}`, { method: 'PATCH', json: { done: true } }) },
  }
  return self
}
