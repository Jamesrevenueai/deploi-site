/**
 * Zoho CRM (API console "server-based application"; OAuth 2.0 with data centers; CRM REST API v6).
 *  - Data centers: US (.com), EU (.eu), India (.in), Australia (.com.au). Each has its own accounts server
 *    (accounts.zoho.<dc>) and API domain (www.zohoapis.<dc>). Consent starts on the default accounts server; the
 *    callback names the customer's own (`accounts-server`, `location`), and the code is exchanged there. The token
 *    answer's api_domain is stored as the connection's api_base; refresh and revoke go to the matching accounts server.
 *  - access_type=offline + prompt=consent gives a refresh token (it does not rotate); access tokens last an hour.
 *  - Authorization header: "Zoho-oauthtoken <token>". Revoke: POST {accounts}/oauth/v2/token/revoke?token=<refresh>.
 *  - Modules: Leads, Contacts, Deals (read, create, update), Tasks and Notes. Search answers 204 when nothing matches.
 * Sources: zoho.com/crm/developer/docs/api/v6 (oauth-overview, multi-dc, search-records, insert-records, update-records,
 * get-records with If-Modified-Since). Official MCP: Zoho offers Zoho MCP (see docs/CONNECTIONS.md); Deploi uses REST.
 * Not live-verified: tested against a fake HTTP layer only.
 */
import { officeConfig } from './config'
import { OfficeHttpError, officeRequest, tokenPost } from './http'
import type { OAuthTokens } from './hubspot'
import { httpsOrigin, parseTokens, tokenError } from './oauth'
import { withOfficeToken, type TokenSource } from './token'
import { assertEmail, crmEmail, crmText, type CrmClient, type CrmContact } from '../crm/types'

export const ZOHO_DCS = { com: { accounts: 'https://accounts.zoho.com', api: 'https://www.zohoapis.com' }, eu: { accounts: 'https://accounts.zoho.eu', api: 'https://www.zohoapis.eu' },
  in: { accounts: 'https://accounts.zoho.in', api: 'https://www.zohoapis.in' }, 'com.au': { accounts: 'https://accounts.zoho.com.au', api: 'https://www.zohoapis.com.au' } } as const
export type ZohoDc = keyof typeof ZOHO_DCS
export const ZOHO_SCOPES = ['ZohoCRM.modules.leads.ALL', 'ZohoCRM.modules.contacts.ALL', 'ZohoCRM.modules.deals.ALL', 'ZohoCRM.modules.tasks.ALL', 'ZohoCRM.modules.notes.ALL', 'ZohoCRM.org.READ'] as const
export const ZOHO_MODULES = ['Leads', 'Contacts', 'Deals', 'Tasks'] as const
export type ZohoModule = (typeof ZOHO_MODULES)[number]

/** A data center from what Zoho sent (a dc code, an accounts server or an API domain); anything else is refused. */
export function zohoDc(v: unknown): ZohoDc | null {
  if (typeof v !== 'string') return null
  if (v in ZOHO_DCS) return v as ZohoDc
  const o = httpsOrigin(v)
  for (const [k, d] of Object.entries(ZOHO_DCS)) if (o === d.accounts || o === d.api) return k as ZohoDc
  return null
}

export function zohoAuthorizeUrl(state: string): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: officeConfig.zohoClientId, scope: ZOHO_SCOPES.join(','), redirect_uri: officeConfig.zohoRedirectUrl, access_type: 'offline', prompt: 'consent', state })
  return `${ZOHO_DCS[officeConfig.zohoDefaultDc].accounts}/oauth/v2/auth?${q}`
}

export type ZohoGrant = OAuthTokens & { dc: ZohoDc; apiDomain: string }

/** Exchange on the customer's own accounts server (from the callback); the API domain must belong to the same data center. */
export async function zohoExchange(code: string, accountsServer: string | null): Promise<ZohoGrant> {
  const dc = zohoDc(accountsServer ?? officeConfig.zohoDefaultDc)
  if (!dc) throw new OfficeHttpError(400, 'invalid', 'Zoho named an accounts server Deploi does not know', 'zoho_crm')
  const r = await tokenPost('zoho_crm', `${ZOHO_DCS[dc].accounts}/oauth/v2/token`, { grant_type: 'authorization_code', client_id: officeConfig.zohoClientId, client_secret: officeConfig.zohoClientSecret, redirect_uri: officeConfig.zohoRedirectUrl, code })
  // Zoho answers 200 with { error: 'invalid_code' } for a refused code
  if (r.status !== 200 || !r.json.access_token) throw tokenError('Zoho', 'exchange', r.status === 200 ? 400 : r.status, r.json)
  const apiDc = zohoDc(r.json.api_domain ?? ZOHO_DCS[dc].api)
  if (apiDc !== dc) throw new OfficeHttpError(400, 'invalid', 'Zoho returned an API domain of another data center', 'zoho_crm')
  return { ...parseTokens(r.json, [...ZOHO_SCOPES], /[ ,]+/), dc, apiDomain: ZOHO_DCS[dc].api }
}

export async function zohoRefresh(refreshToken: string, scopes: string[], apiBase: string | null): Promise<OAuthTokens> {
  const dc = zohoDc(apiBase ?? '')
  if (!dc) throw Object.assign(new Error('the Zoho connection has no known data center'), { auth: true })
  const r = await tokenPost('zoho_crm', `${ZOHO_DCS[dc].accounts}/oauth/v2/token`, { grant_type: 'refresh_token', client_id: officeConfig.zohoClientId, client_secret: officeConfig.zohoClientSecret, refresh_token: refreshToken })
  if (r.status !== 200 || !r.json.access_token) throw tokenError('Zoho', 'refresh', r.status === 200 ? 400 : r.status, r.json)
  const t = parseTokens(r.json, scopes, /[ ,]+/)
  return { ...t, refreshToken: t.refreshToken ?? refreshToken }
}

export async function zohoRevoke(refreshToken: string, apiBase: string | null): Promise<boolean> {
  const dc = zohoDc(apiBase ?? '')
  if (!dc) return false
  try { const r = await tokenPost('zoho_crm', `${ZOHO_DCS[dc].accounts}/oauth/v2/token/revoke?${new URLSearchParams({ token: refreshToken })}`, {}); return r.status === 200 } catch { return false }
}

const zId = (id: string) => { if (!/^\d{5,25}$/.test(id)) throw new OfficeHttpError(400, 'invalid', 'not a Zoho record id', 'zoho_crm'); return id }
const zModule = (m: string): ZohoModule => { if (!(ZOHO_MODULES as readonly string[]).includes(m)) throw new OfficeHttpError(400, 'invalid', 'that Zoho module is not available to Deploi', 'zoho_crm'); return m as ZohoModule }
const PERSON_FIELDS = 'First_Name,Last_Name,Email,Phone,Modified_Time'

type ZRecord = { id?: string; [k: string]: unknown }
type ZWrite = { data?: { code?: string; status?: string; details?: { id?: string }; message?: string }[] }

export function toZohoContact(r: ZRecord, kind: 'lead' | 'contact'): CrmContact {
  return { id: String(r.id ?? ''), kind, email: crmEmail(r.Email), firstName: crmText(r.First_Name, 80), lastName: crmText(r.Last_Name, 80), phone: crmText(r.Phone, 40),
    company: kind === 'lead' ? crmText(r.Company, 255) : crmText((r.Account_Name as { name?: string } | null | undefined)?.name, 255), updatedAt: crmText(r.Modified_Time, 40) }
}

export interface ZohoApi extends CrmClient {
  org(): Promise<{ id: string; name: string | null }>
  getRecord(module: ZohoModule, id: string): Promise<ZRecord | null>
  createRecord(module: ZohoModule, fields: Record<string, unknown>): Promise<{ id: string }>
  updateRecord(module: ZohoModule, id: string, fields: Record<string, unknown>): Promise<void>
  listRecords(module: ZohoModule, o: { fields: string[]; modifiedSince?: Date; page?: number; perPage?: number }): Promise<{ records: ZRecord[]; more: boolean }>
}

export function zohoClient(tokens: TokenSource, apiBase: string): ZohoApi {
  const dc = zohoDc(apiBase)
  if (!dc) throw new OfficeHttpError(400, 'invalid', 'not a Zoho API domain', 'zoho_crm')
  const base = `${ZOHO_DCS[dc].api}/crm/v6`
  const call = <T>(path: string, init: RequestInit & { json?: unknown; retryServer?: boolean; extra?: Record<string, string> } = {}) =>
    withOfficeToken(tokens, async t => (await officeRequest<T>('zoho_crm', `${base}${path}`, { ...init, headers: { authorization: `Zoho-oauthtoken ${t}`, ...(init.extra ?? {}) } })).body)
  const written = (r: ZWrite, what: string) => {
    const d = r.data?.[0]
    if (!d || d.code !== 'SUCCESS' || !d.details?.id) throw new OfficeHttpError(400, 'invalid', `Zoho did not ${what} the record (${String(d?.code ?? 'no answer').replace(/[^\w]/g, '').slice(0, 40)})`, 'zoho_crm')
    return { id: String(d.details.id) }
  }
  const search = async (module: 'Leads' | 'Contacts', email: string) => {
    const r = await call<{ data?: ZRecord[] }>(`/${module}/search?${new URLSearchParams({ email, fields: `${PERSON_FIELDS},${module === 'Leads' ? 'Company' : 'Account_Name'}` })}`, { retryServer: true })
    return r.data?.[0] ?? null // 204 No Content is an empty body: nothing matched
  }
  const self: ZohoApi = {
    provider: 'zoho_crm',
    async org() {
      const r = await call<{ org?: { id?: string; company_name?: string }[] }>('/org', { retryServer: true })
      const o = r.org?.[0]
      if (!o?.id) throw new OfficeHttpError(200, 'server', 'Zoho did not return the organization', 'zoho_crm')
      return { id: String(o.id), name: crmText(o.company_name, 120) }
    },
    async getRecord(module, id) {
      try { const r = await call<{ data?: ZRecord[] }>(`/${zModule(module)}/${zId(id)}`, { retryServer: true }); return r.data?.[0] ?? null } catch (e) { if (e instanceof OfficeHttpError && (e.code === 'not_found' || e.status === 204)) return null; throw e }
    },
    async createRecord(module, fields) { return written(await call<ZWrite>(`/${zModule(module)}`, { method: 'POST', json: { data: [fields], trigger: [] } }), 'create') },
    async updateRecord(module, id, fields) { written(await call<ZWrite>(`/${zModule(module)}/${zId(id)}`, { method: 'PUT', json: { data: [fields], trigger: [] } }), 'update') },
    async listRecords(module, o) {
      const q = new URLSearchParams({ fields: o.fields.filter(f => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f)).join(','), sort_by: 'Modified_Time', sort_order: 'asc', page: String(Math.max(1, o.page ?? 1)), per_page: String(Math.min(Math.max(o.perPage ?? 200, 1), 200)) })
      const r = await call<{ data?: ZRecord[]; info?: { more_records?: boolean } }>(`/${zModule(module)}?${q}`, { retryServer: true, extra: o.modifiedSince ? { 'if-modified-since': o.modifiedSince.toISOString().replace(/\.\d{3}Z$/, '+00:00') } : {} })
      return { records: r.data ?? [], more: Boolean(r.info?.more_records) }
    },
    async findContactByEmail(email) {
      const e = assertEmail(email)
      const c = await search('Contacts', e)
      if (c) return toZohoContact(c, 'contact')
      const l = await search('Leads', e)
      return l ? toZohoContact(l, 'lead') : null
    },
    async upsertContact(i) {
      const email = assertEmail(i.email)
      const found = await self.findContactByEmail(email)
      const fields: Record<string, unknown> = {}
      if (i.firstName) fields.First_Name = i.firstName.slice(0, 40)
      if (i.lastName) fields.Last_Name = i.lastName.slice(0, 80)
      if (i.phone) fields.Phone = i.phone.slice(0, 30)
      if (found) {
        if (found.kind === 'lead' && i.company) fields.Company = i.company.slice(0, 200)
        if (Object.keys(fields).length) await self.updateRecord(found.kind === 'lead' ? 'Leads' : 'Contacts', found.id, fields)
        return { contact: { ...found, firstName: i.firstName ?? found.firstName, lastName: i.lastName ?? found.lastName, phone: i.phone ?? found.phone }, created: false }
      }
      const lead = { ...fields, Email: email, Last_Name: (i.lastName || i.firstName || email.split('@')[0]).slice(0, 80), ...(i.company ? { Company: i.company.slice(0, 200) } : {}), ...(i.source ? { Lead_Source: i.source.slice(0, 100) } : {}) }
      const { id } = await self.createRecord('Leads', lead)
      return { contact: { id, kind: 'lead', email, firstName: i.firstName ?? null, lastName: lead.Last_Name, phone: i.phone ?? null, company: i.company ?? null, updatedAt: null }, created: true }
    },
    async createTask({ contact, subject, body, dueAt }) {
      // a task on a contact uses Who_Id; on a lead, What_Id with the module named
      const link = contact.kind === 'contact' ? { Who_Id: { id: zId(contact.id) } } : { What_Id: { id: zId(contact.id) }, $se_module: 'Leads' }
      return self.createRecord('Tasks', { Subject: subject.slice(0, 255), Due_Date: dueAt.toISOString().slice(0, 10), Status: 'Not Started', ...(body ? { Description: body.slice(0, 32000) } : {}), ...link })
    },
    async addNote({ contact, body }) {
      const mod = contact.kind === 'lead' ? 'Leads' : 'Contacts'
      return written(await call<ZWrite>(`/${mod}/${zId(contact.id)}/Notes`, { method: 'POST', json: { data: [{ Note_Title: body.split('\n')[0].slice(0, 120) || 'Note from Deploi', Note_Content: body.slice(0, 32000) }] } }), 'create')
    },
    async updateDealStage(dealId, stage) {
      await self.updateRecord('Deals', dealId, { Stage: stage.slice(0, 120) })
      const r = await self.getRecord('Deals', dealId)
      return { id: dealId, stage: crmText(r?.Stage, 120) }
    },
    async listChangedContacts({ since, page, limit }) {
      // one page walks Contacts then Leads: "c:<n>" / "l:<n>"
      const [mod, n] = page && /^[cl]:\d{1,4}$/.test(page) ? [page[0], Number(page.slice(2))] : ['c', 1]
      const target = mod === 'c' ? 'Contacts' : 'Leads'
      const r = await self.listRecords(target, { fields: [...PERSON_FIELDS.split(','), target === 'Leads' ? 'Company' : 'Account_Name'], modifiedSince: since, page: n, perPage: limit })
      const next = r.more ? `${mod}:${n + 1}` : mod === 'c' ? 'l:1' : null
      return { contacts: r.records.map(x => toZohoContact(x, target === 'Leads' ? 'lead' : 'contact')), next }
    },
  }
  return self
}
