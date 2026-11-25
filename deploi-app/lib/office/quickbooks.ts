/**
 * QuickBooks Online (Intuit OAuth 2.0 + Accounting API v3). Reads: open invoices (the query endpoint, paged),
 * one invoice, one payment, one customer, the company name, and the change data capture feed (/cdc) for change
 * detection. Writes (launch build, used only for actions the owner approves or grants): create an invoice, record a
 * payment against an invoice, and send an invoice by email. Every write carries a requestid, so a retried write
 * after a lost answer is not applied twice (Intuit returns the original result for a repeated requestid). The company (realmId) is fixed when the connection is made: every request goes to
 * /v3/company/{that realmId}, and a connection can never be pointed at another company.
 * Intuit refresh tokens rotate: every refresh answer carries the refresh token to use next time, and
 * the newest one is stored (encrypted) under the credential row lock (lib/office/credentials.ts).
 * Not live-verified: see docs/QUICKBOOKS-SETUP.md.
 */
import { officeConfig } from './config'
import { OfficeHttpError, officeRequest, tokenPost } from './http'
import type { OAuthTokens } from './hubspot'

export const QBO_AUTHORIZE = 'https://appcenter.intuit.com/connect/oauth2'
export const QBO_TOKEN = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
export const QBO_REVOKE = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'
export const QBO_API = 'https://quickbooks.api.intuit.com'
export const QBO_SANDBOX_API = 'https://sandbox-quickbooks.api.intuit.com'
/** the only scope requested: the Accounting API (Deploi uses it to read) */
export const QBO_SCOPES = ['com.intuit.quickbooks.accounting'] as const
/** the most invoices one query page asks for (Intuit allows up to 1000) */
export const QBO_PAGE = 100

export const isRealmId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v)
const entityId = (id: string) => { if (!/^\d{1,20}$/.test(id)) throw new OfficeHttpError(400, 'invalid', 'not a QuickBooks id', 'quickbooks'); return id }

export function quickbooksAuthorizeUrl(state: string): string {
  const q = new URLSearchParams({ client_id: officeConfig.quickbooksClientId, response_type: 'code', scope: QBO_SCOPES.join(' '), redirect_uri: officeConfig.quickbooksRedirectUrl, state })
  return `${QBO_AUTHORIZE}?${q}`
}

const basic = () => `Basic ${Buffer.from(`${officeConfig.quickbooksClientId}:${officeConfig.quickbooksClientSecret}`).toString('base64')}`

function tokenSet(j: Record<string, unknown>): OAuthTokens {
  return { accessToken: String(j.access_token ?? ''), refreshToken: j.refresh_token ? String(j.refresh_token) : null, expiresIn: typeof j.expires_in === 'number' ? j.expires_in : null, scopes: [...QBO_SCOPES] }
}

export async function quickbooksExchange(code: string): Promise<OAuthTokens> {
  const r = await tokenPost('quickbooks', QBO_TOKEN, { grant_type: 'authorization_code', code, redirect_uri: officeConfig.quickbooksRedirectUrl }, { authorization: basic() })
  if (r.status !== 200 || !r.json.access_token) throw new Error(`QuickBooks token exchange failed (${String(r.json.error ?? r.status).slice(0, 40)})`)
  return tokenSet(r.json)
}

/** Refresh. Intuit rotates the refresh token: the answer's refresh_token replaces the stored one. A refused refresh (invalid_grant) means reconnect. */
export async function quickbooksRefresh(refreshToken: string): Promise<OAuthTokens> {
  const r = await tokenPost('quickbooks', QBO_TOKEN, { grant_type: 'refresh_token', refresh_token: refreshToken }, { authorization: basic() })
  if (r.status !== 200 || !r.json.access_token) throw Object.assign(new Error(`QuickBooks token refresh failed (${String(r.json.error ?? r.status).slice(0, 40)})`), { auth: r.status === 400 || r.status === 401 })
  const t = tokenSet(r.json)
  return { ...t, refreshToken: t.refreshToken ?? refreshToken }
}

/** Revoke on disconnect (the refresh token revokes the whole grant). Best effort: the stored credential is deleted either way. */
export async function quickbooksRevoke(token: string): Promise<boolean> {
  try {
    await officeRequest('quickbooks', QBO_REVOKE, { method: 'POST', json: { token }, headers: { authorization: basic() } })
    return true
  } catch { return false }
}

// ---------------------------------------------------------------- the Accounting API (reads only)

export type QboInvoice = {
  id: string; docNumber: string | null; txnDate: string | null; dueDate: string | null
  totalAmt: number; balance: number; currency: string | null
  customerId: string | null; customerName: string | null
  /** the invoice's own billing address (BillEmail): the only address a reminder may go to */
  billEmail: string | null
  privateNote: string | null
  /** Payment transactions QuickBooks links to this invoice */
  linkedPaymentIds: string[]
  updatedAt: string | null
}
export type QboPayment = { id: string; totalAmt: number; txnDate: string | null; customerId: string | null; appliedTo: { invoiceId: string; amount: number }[] }
export type QboCustomer = { id: string; displayName: string | null; email: string | null; active: boolean }

export interface QuickBooksApi {
  companyInfo(): Promise<{ name: string | null }>
  /** invoices with Balance > 0, one page; `next` is the STARTPOSITION of the next page */
  listOpenInvoices(o: { startPosition: number; maxResults: number }): Promise<{ invoices: QboInvoice[]; next: number | null }>
  getInvoice(id: string): Promise<QboInvoice | null>
  getPayment(id: string): Promise<QboPayment | null>
  getCustomer(id: string): Promise<QboCustomer | null>
}

const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Math.round(Number(v) * 100) / 100 : 0)
const str = (v: unknown, n = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
type Ref = { value?: string; name?: string }
type RawInvoice = { Id?: string; DocNumber?: string; TxnDate?: string; DueDate?: string; TotalAmt?: number; Balance?: number; CurrencyRef?: Ref; CustomerRef?: Ref
  BillEmail?: { Address?: string }; PrivateNote?: string; LinkedTxn?: { TxnId?: string; TxnType?: string }[]; MetaData?: { LastUpdatedTime?: string } }

export function toInvoice(r: RawInvoice): QboInvoice {
  const email = str(r.BillEmail?.Address, 254)?.toLowerCase() ?? null
  return {
    id: String(r.Id ?? ''), docNumber: str(r.DocNumber, 40), txnDate: date(r.TxnDate), dueDate: date(r.DueDate), totalAmt: money(r.TotalAmt), balance: money(r.Balance),
    currency: str(r.CurrencyRef?.value, 3)?.toUpperCase() ?? null, customerId: str(r.CustomerRef?.value, 20), customerName: str(r.CustomerRef?.name, 120),
    billEmail: email && /^[^\s@<>(),;:"[\]\\]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(email) && !/[,;]/.test(email) ? email : null,
    privateNote: str(r.PrivateNote, 1000), linkedPaymentIds: (r.LinkedTxn ?? []).filter(t => t.TxnType === 'Payment' && t.TxnId).map(t => String(t.TxnId)),
    updatedAt: str(r.MetaData?.LastUpdatedTime, 40),
  }
}
type RawPayment = { Id?: string; TotalAmt?: number; TxnDate?: string; CustomerRef?: Ref; Line?: { Amount?: number; LinkedTxn?: { TxnId?: string; TxnType?: string }[] }[] }
export function toPayment(r: RawPayment): QboPayment {
  return { id: String(r.Id ?? ''), totalAmt: money(r.TotalAmt), txnDate: date(r.TxnDate), customerId: str(r.CustomerRef?.value, 20),
    appliedTo: (r.Line ?? []).flatMap(l => (l.LinkedTxn ?? []).filter(t => t.TxnType === 'Invoice' && t.TxnId).map(t => ({ invoiceId: String(t.TxnId), amount: money(l.Amount) }))) }
}

/** "Object Not Found": QuickBooks answers 400 ValidationFault code 610 for a deleted or unknown id, not 404 */
const notFound = (e: unknown) => e instanceof OfficeHttpError && (e.code === 'not_found' || (e.code === 'invalid' && /Fault 610\b/.test(e.message)))

export const quickbooksBase = () => (officeConfig.quickbooksSandbox ? QBO_SANDBOX_API : QBO_API)

export type QboLine = { amount: number; description?: string | null; itemId?: string | null; qty?: number | null; unitPrice?: number | null }
export type QboChange = { entity: 'Invoice' | 'Payment'; id: string; deleted: boolean; updatedAt: string | null }

/** Reads plus the launch-build writes and the change feed (the synthetic provider implements the reads only). */
export interface QuickBooksFullApi extends QuickBooksApi {
  createInvoice(i: { customerId: string; lines: QboLine[]; dueDate?: string | null; billEmail?: string | null; docNumber?: string | null; requestId: string }): Promise<QboInvoice>
  recordPayment(p: { customerId: string; amount: number; invoiceId: string; txnDate?: string | null; requestId: string }): Promise<QboPayment>
  /** email the invoice (to its BillEmail, or `to`); QuickBooks records the send on the invoice */
  sendInvoice(id: string, opts?: { to?: string | null; requestId?: string }): Promise<{ id: string; emailStatus: string | null }>
  /** invoices and payments created, changed or deleted since `since` (at most 30 days back, Intuit's limit) */
  changes(since: Date): Promise<QboChange[]>
}

const requestId = (v: string) => { if (!/^[\w-]{1,50}$/.test(v)) throw new OfficeHttpError(400, 'invalid', 'a QuickBooks requestid is 1-50 letters, digits, _ or -', 'quickbooks'); return v }
const amount = (v: number) => { if (!Number.isFinite(v) || v <= 0 || v > 1e9) throw new OfficeHttpError(400, 'invalid', 'not a valid amount', 'quickbooks'); return Math.round(v * 100) / 100 }

export function quickbooksClient(token: () => Promise<string>, realmId: string, opts: { refresh?: (rejected: string) => Promise<string> } = {}): QuickBooksFullApi {
  if (!isRealmId(realmId)) throw new OfficeHttpError(400, 'invalid', 'not a QuickBooks company id', 'quickbooks')
  // a 401 refreshes the token once and repeats the request (a refused request was not applied)
  const authed = async <T>(fn: (t: string) => Promise<T>): Promise<T> => {
    const t = await token()
    try { return await fn(t) } catch (e) {
      if (!opts.refresh || !(e instanceof OfficeHttpError) || e.code !== 'auth') throw e
      return fn(await opts.refresh(t))
    }
  }
  const url = (path: string, params: Record<string, string> = {}) => `${quickbooksBase()}/v3/company/${realmId}${path}?${new URLSearchParams({ ...params, minorversion: officeConfig.quickbooksMinorVersion })}`
  const get = <T>(path: string, params: Record<string, string> = {}): Promise<T> =>
    authed(async t => (await officeRequest<T>('quickbooks', url(path, params), { headers: { authorization: `Bearer ${t}` }, retryServer: true })).body)
  const post = <T>(path: string, body: unknown, params: Record<string, string> = {}): Promise<T> =>
    authed(async t => (await officeRequest<T>('quickbooks', url(path, params), { method: 'POST', json: body, headers: { authorization: `Bearer ${t}` } })).body)
  const maybe = async <T>(path: string): Promise<T | null> => { try { return await get<T>(path) } catch (e) { if (notFound(e)) return null; throw e } }
  return {
    async companyInfo() {
      const r = await get<{ CompanyInfo?: { CompanyName?: string } }>(`/companyinfo/${realmId}`)
      return { name: str(r.CompanyInfo?.CompanyName, 120) }
    },
    async listOpenInvoices({ startPosition, maxResults }) {
      const start = Math.max(1, Math.floor(startPosition)), max = Math.min(Math.max(1, Math.floor(maxResults)), 1000)
      const r = await get<{ QueryResponse?: { Invoice?: RawInvoice[] } }>('/query', { query: `select * from Invoice where Balance > '0' STARTPOSITION ${start} MAXRESULTS ${max}` })
      const rows = r.QueryResponse?.Invoice ?? []
      return { invoices: rows.map(toInvoice).filter(i => i.id), next: rows.length >= max ? start + max : null }
    },
    async getInvoice(id) { const r = await maybe<{ Invoice?: RawInvoice }>(`/invoice/${entityId(id)}`); return r?.Invoice ? toInvoice(r.Invoice) : null },
    async getPayment(id) { const r = await maybe<{ Payment?: RawPayment }>(`/payment/${entityId(id)}`); return r?.Payment ? toPayment(r.Payment) : null },
    async getCustomer(id) {
      const r = await maybe<{ Customer?: { Id?: string; DisplayName?: string; PrimaryEmailAddr?: { Address?: string }; Active?: boolean } }>(`/customer/${entityId(id)}`)
      const c = r?.Customer
      return c ? { id: String(c.Id ?? id), displayName: str(c.DisplayName, 120), email: str(c.PrimaryEmailAddr?.Address, 254)?.toLowerCase() ?? null, active: c.Active !== false } : null
    },
    async createInvoice(i) {
      if (!i.lines.length) throw new OfficeHttpError(400, 'invalid', 'an invoice needs at least one line', 'quickbooks')
      const body = {
        CustomerRef: { value: entityId(i.customerId) },
        Line: i.lines.map(l => ({ Amount: amount(l.amount), DetailType: 'SalesItemLineDetail', ...(l.description ? { Description: l.description.slice(0, 4000) } : {}),
          SalesItemLineDetail: { ...(l.itemId ? { ItemRef: { value: entityId(l.itemId) } } : {}), ...(l.qty ? { Qty: l.qty } : {}), ...(l.unitPrice ? { UnitPrice: l.unitPrice } : {}) } })),
        ...(i.dueDate && date(i.dueDate) ? { DueDate: i.dueDate } : {}),
        ...(i.billEmail ? { BillEmail: { Address: i.billEmail.slice(0, 100) } } : {}),
        ...(i.docNumber ? { DocNumber: i.docNumber.slice(0, 21) } : {}),
      }
      const r = await post<{ Invoice?: RawInvoice }>('/invoice', body, { requestid: requestId(i.requestId) })
      if (!r.Invoice?.Id) throw new OfficeHttpError(200, 'server', 'QuickBooks did not return the new invoice', 'quickbooks')
      return toInvoice(r.Invoice)
    },
    async recordPayment(p) {
      const amt = amount(p.amount)
      const body = { CustomerRef: { value: entityId(p.customerId) }, TotalAmt: amt, ...(p.txnDate && date(p.txnDate) ? { TxnDate: p.txnDate } : {}),
        Line: [{ Amount: amt, LinkedTxn: [{ TxnId: entityId(p.invoiceId), TxnType: 'Invoice' }] }] }
      const r = await post<{ Payment?: RawPayment }>('/payment', body, { requestid: requestId(p.requestId) })
      if (!r.Payment?.Id) throw new OfficeHttpError(200, 'server', 'QuickBooks did not return the new payment', 'quickbooks')
      return toPayment(r.Payment)
    },
    async sendInvoice(id, o = {}) {
      const params: Record<string, string> = {}
      if (o.to) params.sendTo = o.to.slice(0, 100)
      if (o.requestId) params.requestid = requestId(o.requestId)
      const r = await authed(async t => (await officeRequest<{ Invoice?: RawInvoice & { EmailStatus?: string } }>('quickbooks', url(`/invoice/${entityId(id)}/send`, params),
        { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/octet-stream' } })).body)
      return { id, emailStatus: str(r.Invoice?.EmailStatus, 40) }
    },
    async changes(since) {
      const oldest = Date.now() - 30 * 864e5
      const at = new Date(Math.max(since.getTime(), oldest)).toISOString().replace(/\.\d{3}Z$/, 'Z')
      const r = await get<{ CDCResponse?: { QueryResponse?: { Invoice?: (RawInvoice & { status?: string })[]; Payment?: (RawPayment & { status?: string; MetaData?: { LastUpdatedTime?: string } })[] }[] }[] }>('/cdc', { entities: 'Invoice,Payment', changedSince: at })
      const out: QboChange[] = []
      for (const qr of r.CDCResponse?.[0]?.QueryResponse ?? []) {
        for (const x of qr.Invoice ?? []) if (x.Id) out.push({ entity: 'Invoice', id: String(x.Id), deleted: x.status === 'Deleted', updatedAt: str(x.MetaData?.LastUpdatedTime, 40) })
        for (const x of qr.Payment ?? []) if (x.Id) out.push({ entity: 'Payment', id: String(x.Id), deleted: x.status === 'Deleted', updatedAt: str(x.MetaData?.LastUpdatedTime, 40) })
      }
      return out
    },
  }
}
