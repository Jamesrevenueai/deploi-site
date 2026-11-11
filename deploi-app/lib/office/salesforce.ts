/**
 * Salesforce (connected app; OAuth 2.0 web server flow with PKCE, REST API).
 *  - Consent: {login}/services/oauth2/authorize with code_challenge (S256), scopes `api refresh_token`.
 *  - Token: {login}/services/oauth2/token answers access_token, refresh_token, instance_url and `id`
 *    (https://login.salesforce.com/id/<orgId>/<userId>). Every API call goes to that instance_url (stored as the
 *    connection's api_base, re-checked against *.my.salesforce.com on every request). Salesforce does not say when
 *    an access token expires (it follows the org's session timeout), so a 401 INVALID_SESSION_ID refreshes the token
 *    once and repeats the call. Refresh answers do not rotate the refresh token.
 *  - Revoke: {login}/services/oauth2/revoke with the refresh token (revokes the whole grant).
 *  - REST: /services/data/<version>/sobjects/{Lead|Contact|Opportunity|Task|Note} get / create (POST) / update
 *    (PATCH, 204) and SOQL /query. Only those object types are reachable from here.
 * Sources: help.salesforce.com "OAuth 2.0 Web Server Flow", developer.salesforce.com REST API Developer Guide.
 * Official MCP: Salesforce publishes a hosted MCP server for its platform (see docs/CONNECTIONS.md); Deploi uses REST.
 * Not live-verified: tested against a fake HTTP layer only.
 */
import { officeConfig } from './config'
import { OfficeHttpError, officeRequest, tokenPost } from './http'
import type { OAuthTokens } from './hubspot'
import { httpsOrigin, parseTokens, tokenError } from './oauth'
import { withOfficeToken, type TokenSource } from './token'
import { assertEmail, crmEmail, crmText, type CrmClient, type CrmContact } from '../crm/types'
import { assertApprovedHost } from '../net/outbound'

export const SALESFORCE_SCOPES = ['api', 'refresh_token'] as const
export const SF_TYPES = ['Lead', 'Contact', 'Opportunity', 'Task', 'Note'] as const
export type SfType = (typeof SF_TYPES)[number]
const login = () => officeConfig.salesforceLoginUrl

export function salesforceAuthorizeUrl(state: string, codeChallenge: string): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: officeConfig.salesforceClientId, redirect_uri: officeConfig.salesforceRedirectUrl,
    scope: SALESFORCE_SCOPES.join(' '), state, code_challenge: codeChallenge, code_challenge_method: 'S256', prompt: 'login consent' })
  return `${login()}/services/oauth2/authorize?${q}`
}

/** The instance a token belongs to: only a Salesforce host is ever accepted. */
export function salesforceInstance(v: unknown): string {
  const o = httpsOrigin(v)
  if (!o) throw new OfficeHttpError(400, 'invalid', 'Salesforce did not return an instance URL', 'salesforce')
  try { assertApprovedHost(`${o}/`, 'salesforce') } catch { throw new OfficeHttpError(400, 'invalid', 'Salesforce named a server that is not a Salesforce host', 'salesforce') }
  return o
}
/** "https://login.salesforce.com/id/00D.../005..." -> the org and user ids */
export function salesforceIds(idUrl: unknown): { orgId: string; userId: string } {
  const m = typeof idUrl === 'string' ? /\/id\/(00D[A-Za-z0-9]{12,15})\/(005[A-Za-z0-9]{12,15})$/.exec(idUrl) : null
  if (!m) throw new OfficeHttpError(400, 'invalid', 'Salesforce did not return the organization id', 'salesforce')
  return { orgId: m[1], userId: m[2] }
}

export type SalesforceGrant = OAuthTokens & { instanceUrl: string; orgId: string; userId: string }

export async function salesforceExchange(code: string, verifier: string): Promise<SalesforceGrant> {
  const r = await tokenPost('salesforce', `${login()}/services/oauth2/token`, { grant_type: 'authorization_code', code, client_id: officeConfig.salesforceClientId,
    client_secret: officeConfig.salesforceClientSecret, redirect_uri: officeConfig.salesforceRedirectUrl, code_verifier: verifier })
  if (r.status !== 200 || !r.json.access_token) throw tokenError('Salesforce', 'exchange', r.status, r.json)
  return { ...parseTokens(r.json, [...SALESFORCE_SCOPES], / +/), instanceUrl: salesforceInstance(r.json.instance_url), ...salesforceIds(r.json.id) }
}

export async function salesforceRefresh(refreshToken: string, scopes: string[]): Promise<OAuthTokens & { apiBase: string | null }> {
  const r = await tokenPost('salesforce', `${login()}/services/oauth2/token`, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: officeConfig.salesforceClientId, client_secret: officeConfig.salesforceClientSecret })
  if (r.status !== 200 || !r.json.access_token) throw tokenError('Salesforce', 'refresh', r.status, r.json)
  const t = parseTokens(r.json, scopes, / +/)
  return { ...t, refreshToken: t.refreshToken ?? refreshToken, apiBase: r.json.instance_url ? salesforceInstance(r.json.instance_url) : null }
}

export async function salesforceRevoke(token: string): Promise<boolean> {
  try { const r = await tokenPost('salesforce', `${login()}/services/oauth2/revoke`, { token }); return r.status === 200 } catch { return false }
}

const sfId = (id: string) => { if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id)) throw new OfficeHttpError(400, 'invalid', 'not a Salesforce record id', 'salesforce'); return id }
const sfType = (t: string): SfType => { if (!(SF_TYPES as readonly string[]).includes(t)) throw new OfficeHttpError(400, 'invalid', 'that Salesforce object is not available to Deploi', 'salesforce'); return t as SfType }
/** SOQL string literal (backslash and quote escaped) */
export const soql = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const soqlTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

type SfRecord = { Id?: string; attributes?: { type?: string }; [k: string]: unknown }
const PERSON_FIELDS = 'Id, FirstName, LastName, Email, Phone, LastModifiedDate'

export function toSfContact(r: SfRecord, kind: 'lead' | 'contact'): CrmContact {
  return { id: String(r.Id ?? ''), kind, email: crmEmail(r.Email), firstName: crmText(r.FirstName, 80), lastName: crmText(r.LastName, 80), phone: crmText(r.Phone, 40),
    company: kind === 'lead' ? crmText(r.Company, 255) : crmText((r.Account as { Name?: string } | null | undefined)?.Name, 255), updatedAt: crmText(r.LastModifiedDate, 40) }
}

export interface SalesforceApi extends CrmClient {
  getRecord(type: SfType, id: string, fields?: string[]): Promise<SfRecord | null>
  createRecord(type: SfType, fields: Record<string, unknown>): Promise<{ id: string }>
  updateRecord(type: SfType, id: string, fields: Record<string, unknown>): Promise<void>
  query(q: string): Promise<{ records: SfRecord[]; next: string | null }>
  identity(): Promise<{ orgName: string | null }>
}

export function salesforceClient(tokens: TokenSource, instanceUrl: string): SalesforceApi {
  const base = salesforceInstance(instanceUrl)
  const v = officeConfig.salesforceApiVersion
  const call = <T>(path: string, init: RequestInit & { json?: unknown; retryServer?: boolean } = {}) =>
    withOfficeToken(tokens, async t => (await officeRequest<T>('salesforce', `${base}${path}`, { ...init, headers: { authorization: `Bearer ${t}` } })).body)
  const maybe = async <T>(path: string): Promise<T | null> => { try { return await call<T>(path, { retryServer: true }) } catch (e) { if (e instanceof OfficeHttpError && e.code === 'not_found') return null; throw e } }
  const query = async (q: string) => {
    const r = await call<{ records?: SfRecord[]; nextRecordsUrl?: string; done?: boolean }>(`/services/data/${v}/query?${new URLSearchParams({ q })}`, { retryServer: true })
    return { records: r.records ?? [], next: r.nextRecordsUrl && /^\/services\/data\/v\d+\.0\/query\/[\w-]+$/.test(r.nextRecordsUrl) ? r.nextRecordsUrl : null }
  }
  const create = async (type: SfType, fields: Record<string, unknown>) => {
    const r = await call<{ id?: string; success?: boolean }>(`/services/data/${v}/sobjects/${sfType(type)}/`, { method: 'POST', json: fields })
    if (!r.id || r.success === false) throw new OfficeHttpError(200, 'server', 'Salesforce did not return the new record id', 'salesforce')
    return { id: String(r.id) }
  }
  const update = async (type: SfType, id: string, fields: Record<string, unknown>) => { await call(`/services/data/${v}/sobjects/${sfType(type)}/${sfId(id)}`, { method: 'PATCH', json: fields }) }
  const self: SalesforceApi = {
    provider: 'salesforce',
    async getRecord(type, id, fields) {
      return maybe<SfRecord>(`/services/data/${v}/sobjects/${sfType(type)}/${sfId(id)}${fields?.length ? `?fields=${fields.filter(f => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(f)).join(',')}` : ''}`)
    },
    createRecord: create,
    updateRecord: update,
    query,
    async identity() {
      const r = await query('SELECT Name FROM Organization LIMIT 1')
      return { orgName: crmText(r.records[0]?.Name, 120) }
    },
    async findContactByEmail(email) {
      const e = soql(assertEmail(email))
      const c = await query(`SELECT ${PERSON_FIELDS}, Account.Name FROM Contact WHERE Email = ${e} ORDER BY LastModifiedDate DESC LIMIT 1`)
      if (c.records[0]) return toSfContact(c.records[0], 'contact')
      const l = await query(`SELECT ${PERSON_FIELDS}, Company FROM Lead WHERE Email = ${e} AND IsConverted = false ORDER BY LastModifiedDate DESC LIMIT 1`)
      return l.records[0] ? toSfContact(l.records[0], 'lead') : null
    },
    async upsertContact(i) {
      const email = assertEmail(i.email)
      const found = await self.findContactByEmail(email)
      const fields: Record<string, unknown> = {}
      if (i.firstName) fields.FirstName = i.firstName.slice(0, 40)
      if (i.lastName) fields.LastName = i.lastName.slice(0, 80)
      if (i.phone) fields.Phone = i.phone.slice(0, 40)
      if (found) {
        if (found.kind === 'lead' && i.company) fields.Company = i.company.slice(0, 255)
        if (Object.keys(fields).length) await update(found.kind === 'lead' ? 'Lead' : 'Contact', found.id, fields)
        return { contact: { ...found, firstName: i.firstName ?? found.firstName, lastName: i.lastName ?? found.lastName, phone: i.phone ?? found.phone }, created: false }
      }
      // a Lead needs LastName and Company: Salesforce rejects the record without them
      const lead = { ...fields, Email: email, LastName: (i.lastName || i.firstName || email.split('@')[0]).slice(0, 80), Company: (i.company || 'Not provided').slice(0, 255), ...(i.source ? { LeadSource: i.source.slice(0, 40) } : {}) }
      const { id } = await create('Lead', lead)
      return { contact: { id, kind: 'lead', email, firstName: i.firstName ?? null, lastName: lead.LastName, phone: i.phone ?? null, company: lead.Company, updatedAt: null }, created: true }
    },
    async createTask({ contact, subject, body, dueAt }) {
      return create('Task', { WhoId: sfId(contact.id), Subject: subject.slice(0, 255), Description: body?.slice(0, 32000) ?? null, ActivityDate: dueAt.toISOString().slice(0, 10), Status: 'Not Started', Priority: 'Normal' })
    },
    async addNote({ contact, body }) {
      // classic Note (shown under Notes & Attachments); ParentId is the lead or contact
      return create('Note', { ParentId: sfId(contact.id), Title: body.split('\n')[0].slice(0, 80) || 'Note from Deploi', Body: body.slice(0, 32000) })
    },
    async updateDealStage(dealId, stage) {
      await update('Opportunity', dealId, { StageName: stage.slice(0, 255) })
      const r = await self.getRecord('Opportunity', dealId, ['StageName'])
      return { id: dealId, stage: crmText(r?.StageName, 255) }
    },
    async listChangedContacts({ since, page, limit }) {
      const n = Math.min(Math.max(limit ?? 200, 1), 200)
      if (page) {
        if (!/^\/services\/data\/v\d+\.0\/query\/[\w-]+$/.test(page)) throw new OfficeHttpError(400, 'invalid', 'not a Salesforce query page', 'salesforce')
        const r = await call<{ records?: SfRecord[]; nextRecordsUrl?: string }>(page, { retryServer: true })
        return { contacts: (r.records ?? []).map(x => toSfContact(x, x.attributes?.type === 'Lead' ? 'lead' : 'contact')), next: r.nextRecordsUrl ?? null }
      }
      const at = soqlTime(since)
      const c = await query(`SELECT ${PERSON_FIELDS}, Account.Name FROM Contact WHERE LastModifiedDate > ${at} ORDER BY LastModifiedDate ASC LIMIT ${n}`)
      const l = await query(`SELECT ${PERSON_FIELDS}, Company FROM Lead WHERE LastModifiedDate > ${at} AND IsConverted = false ORDER BY LastModifiedDate ASC LIMIT ${n}`)
      const all = [...c.records.map(x => toSfContact(x, 'contact')), ...l.records.map(x => toSfContact(x, 'lead'))].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
      return { contacts: all, next: null }
    },
  }
  return self
}
