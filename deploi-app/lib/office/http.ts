/**
 * HTTP for the office providers (HubSpot, Google Calendar): approved hosts only, one fetch override for
 * tests (no real external call is ever made in a test), timeouts, bounded backoff on 429 and error
 * classification. Errors never echo request or response bodies (they can carry personal data).
 */
import { assertApprovedHost } from '../net/outbound'
import { officeConfig } from './config'

type Fetch = (url: string, init: RequestInit) => Promise<Response>
let override: Fetch | null = null
let sleeper: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
/** tests only: route office provider HTTP through a fake, and make backoff waits instant */
export function setOfficeFetch(f: Fetch | null) { override = f }
export function setOfficeSleep(s: ((ms: number) => Promise<void>) | null) { sleeper = s ?? (ms => new Promise(r => setTimeout(r, ms))) }

export type OfficeErrorCode = 'auth' | 'forbidden' | 'not_found' | 'conflict' | 'gone' | 'rate_limited' | 'invalid' | 'server' | 'network'

export class OfficeHttpError extends Error {
  constructor(public status: number, public code: OfficeErrorCode, message: string, public provider: OfficeHost) { super(message); this.name = 'OfficeHttpError' }
  /** a write with this error may or may not have happened: reconcile before any retry */
  get uncertain() { return this.code === 'server' || this.code === 'network' }
  get retryable() { return this.code === 'rate_limited' || this.uncertain }
}

export function classify(status: number): OfficeErrorCode {
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 410) return 'gone'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server'
  return 'invalid'
}

function retryAfterMs(res: Response, attempt: number): number {
  const v = Number(res.headers.get('retry-after'))
  const ms = Number.isFinite(v) && v > 0 ? v * 1000 : 1000 * 2 ** attempt
  return Math.min(ms, officeConfig.maxRetryWaitMs)
}

/** Short, content-free reason from a provider error body. */
async function reason(res: Response): Promise<string> {
  try {
    const raw = (await res.json()) as unknown
    // Salesforce answers errors as an array: [{ errorCode: 'INVALID_FIELD', message }] (only the code is kept)
    if (Array.isArray(raw)) { const c = (raw[0] as { errorCode?: string } | undefined)?.errorCode; return String(c || res.statusText).replace(/[^\w .:-]/g, '').slice(0, 80) }
    const j = raw as { code?: string | number; errorCode?: string; message?: string; category?: string; error?: { message?: string; status?: string } | string; error_description?: string; Fault?: { type?: string; Error?: { code?: string }[] } }
    // QuickBooks: { Fault: { type: 'ValidationFault', Error: [{ code: '6000', Message, Detail }] } } (only the type and code are kept)
    const fault = j.Fault ? `${j.Fault.type ?? 'Fault'}${j.Fault.Error?.[0]?.code ? ` ${j.Fault.Error[0].code}` : ''}` : ''
    // Zoho: { code: 'INVALID_DATA', message } ; Buildium: { errorCode?, UserMessage } ; Graph: { error: { code, message } }
    const m = fault || (typeof j.error === 'string' ? (j.error_description ?? j.error) : (j.error?.status ?? (j.error as { code?: string } | undefined)?.code ?? j.category ?? j.errorCode ?? (typeof j.code === 'string' ? j.code : '')))
    return String(m || res.statusText).replace(/[^\w .:-]/g, '').slice(0, 80)
  } catch { return res.statusText.slice(0, 80) }
}

export type OfficeHost = 'hubspot' | 'google_calendar' | 'quickbooks' | 'salesforce' | 'pipedrive' | 'zoho_crm' | 'buildium' | 'outlook'
const HOST_LABEL: Record<OfficeHost, string> = { hubspot: 'HubSpot', google_calendar: 'Google Calendar', quickbooks: 'QuickBooks', salesforce: 'Salesforce', pipedrive: 'Pipedrive', zoho_crm: 'Zoho CRM', buildium: 'Buildium', outlook: 'Microsoft 365' }

/**
 * One request to a provider. 429 is retried with a bounded backoff (Retry-After, at most maxRetries
 * times); every other non-2xx becomes an OfficeHttpError. Only GET is retried on a network error:
 * a lost answer to a write is reported as uncertain and reconciled by the caller.
 * `retryServer` (reads only): a GET answered 5xx is also retried with the same bounded backoff.
 */
export async function officeRequest<T = Record<string, unknown>>(provider: OfficeHost, url: string, init: RequestInit & { json?: unknown; retryServer?: boolean } = {}): Promise<{ status: number; body: T; headers: Headers }> {
  assertApprovedHost(url, provider)
  const headers = new Headers(init.headers)
  let body = init.body
  if (init.json !== undefined) { headers.set('content-type', 'application/json'); body = JSON.stringify(init.json) }
  headers.set('accept', 'application/json')
  const method = (init.method ?? 'GET').toUpperCase()
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await (override ?? fetch)(url, { method, headers, body, signal: init.signal ?? AbortSignal.timeout(30_000) })
    } catch {
      if (method === 'GET' && attempt < officeConfig.maxRetries) { await sleeper(500 * 2 ** attempt); continue }
      throw new OfficeHttpError(0, 'network', 'no response from the provider', provider)
    }
    if (res.status === 429 && attempt < officeConfig.maxRetries) { await sleeper(retryAfterMs(res, attempt)); continue }
    if (init.retryServer && method === 'GET' && res.status >= 500 && attempt < officeConfig.maxRetries) { await sleeper(Math.min(500 * 2 ** attempt, officeConfig.maxRetryWaitMs)); continue }
    if (res.status === 204) return { status: 204, body: {} as T, headers: res.headers }
    if (res.ok) {
      // reliability fix R-3 (tests/reliability/providers.test.ts): a 2xx whose body is not JSON (an HTML error page
      // from a proxy, a truncated page) used to read as an empty object, so a search page looked like "no more
      // results" and a write looked done with no id. It is a server error now: retried for reads that allow it,
      // uncertain (reconciled, never blindly repeated) for writes. An empty body is still an empty object.
      const text = await res.text().catch(() => null)
      if (text === null || text.trim() === '') return { status: res.status, body: {} as T, headers: res.headers }
      try { return { status: res.status, body: JSON.parse(text) as T, headers: res.headers } } catch {
        if (init.retryServer && method === 'GET' && attempt < officeConfig.maxRetries) { await sleeper(Math.min(500 * 2 ** attempt, officeConfig.maxRetryWaitMs)); continue }
        throw new OfficeHttpError(res.status, 'server', `${HOST_LABEL[provider]} answered ${res.status} with a body that is not JSON`, provider)
      }
    }
    const code = classify(res.status)
    throw new OfficeHttpError(res.status, code, `${HOST_LABEL[provider]} answered ${res.status}${code === 'rate_limited' ? ' (rate limited after retries)' : ''}: ${await reason(res)}`, provider)
  }
}

/** Form POST to an OAuth token endpoint (no retry: a code can be exchanged only once). */
export async function tokenPost(provider: OfficeHost, url: string, form: Record<string, string>, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  assertApprovedHost(url, provider)
  let res: Response
  try {
    res = await (override ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...extraHeaders }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(30_000) })
  } catch { throw new OfficeHttpError(0, 'network', 'no response from the provider', provider) }
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}
