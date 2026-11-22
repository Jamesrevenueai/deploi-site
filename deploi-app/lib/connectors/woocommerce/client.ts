/**
 * WooCommerce REST v3 client. Real stores: `https://<site>/wp-json/wc/v3/...` with HTTP Basic auth
 * (consumer key as user, secret as password) over HTTPS only. Synthetic stores: the synthetic transport.
 *
 * Reads retry a bounded number of times on HTTP 429, 5xx and network errors, with exponential backoff
 * (honouring a short Retry-After). Writes are sent exactly once: a write whose answer is lost is reported
 * as "unknown" and settled by the engine's verification read, never re-sent blindly.
 *
 * Errors are classified the way the engine needs them:
 *   auth       401/403: key revoked, user deleted, or a read-only key used for a write; reconnect
 *   not_found  404: the record (or the REST route) does not exist
 *   rejected   400/409/413/422 and other definite refusals: the store said no; nothing changed
 *   unknown    429/5xx after retries, timeouts, connection resets, unreadable answers: no definite answer
 * Credentials are never logged, never put in error messages and never returned to a browser.
 */
import { admin } from '../../db'
import { loadCredential } from '../credentials'
import type { ConnectionRow } from '../../engine/types'
import { WC_API_BASE, WC_PER_PAGE, wooConfig } from './config'
import { realWooTransport, WooRequestRefused, type WooMethod, type WooTransport } from './http'
import { syntheticWooTransport } from './synthetic'
import { countWorkflow } from '../../ai/meter'

export type WooCreds = { consumerKey: string; consumerSecret: string }
export type AuthMode = 'basic' | 'query'
export type WooSite = { siteUrl: string; creds: WooCreds | null; authMode: AuthMode; transport: WooTransport }
export type WooErrorKind = 'auth' | 'not_found' | 'rejected' | 'unknown'
export type WooReq = { method?: WooMethod; path: string; query?: Record<string, string | number | boolean | undefined>; body?: unknown }
export type WooResponse<T> = { status: number; headers: Record<string, string>; data: T }

export class WooApiError extends Error {
  constructor(message: string, public kind: WooErrorKind, public status?: number, public code?: string) { super(message); this.name = 'WooApiError' }
}

const CK = /^ck_[a-f0-9]{40}$/
const CS = /^cs_[a-f0-9]{40}$/
/** WooCommerce generates keys as ck_/cs_ + 40 hex characters; anything else is refused before it is stored or sent. */
export function validCreds(c: unknown): c is WooCreds {
  const x = c as WooCreds | null
  return Boolean(x && typeof x.consumerKey === 'string' && typeof x.consumerSecret === 'string' && CK.test(x.consumerKey) && CS.test(x.consumerSecret))
}
export const encodeCreds = (c: WooCreds) => JSON.stringify({ ck: c.consumerKey, cs: c.consumerSecret })
export function decodeCreds(secret: string): WooCreds | null {
  try { const j = JSON.parse(secret) as { ck?: string; cs?: string }; const c = { consumerKey: String(j.ck ?? ''), consumerSecret: String(j.cs ?? '') }; return validCreds(c) ? c : null } catch { return null }
}

/** Test and tuning hooks (never set in production code paths). */
export const wooClientHooks = {
  sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
  transportOverride: null as ((conn: ConnectionRow) => WooTransport) | null,
}
/** Tests only: route real-connection traffic to a stub. */
export function setWooTransportOverride(fn: ((conn: ConnectionRow) => WooTransport) | null) { wooClientHooks.transportOverride = fn }

export function buildUrl(siteUrl: string, path: string, query?: WooReq['query']): string {
  const full = path.startsWith('/wp-json/') ? path : `${WC_API_BASE}${path.startsWith('/') ? path : `/${path}`}`
  const u = new URL(siteUrl.replace(/\/+$/, '') + full)
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v))
  return u.toString()
}

function classify(status: number, body: { code?: string; message?: string } | null): WooApiError {
  const code = typeof body?.code === 'string' ? body.code : undefined
  const msg = typeof body?.message === 'string' ? body.message.replace(/<[^>]*>/g, '').slice(0, 200) : ''
  const text = `HTTP ${status}${code ? ` ${code}` : ''}${msg ? `: ${msg}` : ''}`
  if (status === 401 || status === 403) return new WooApiError(text, 'auth', status, code)
  if (status === 404) return new WooApiError(text, 'not_found', status, code)
  if (status === 429 || status >= 500) return new WooApiError(text, 'unknown', status, code)
  if (status >= 300 && status < 400) return new WooApiError(`HTTP ${status}: the store redirected the request; reconnect using the store's final https address`, 'rejected', status, code)
  return new WooApiError(text, 'rejected', status, code)
}

function retryAfterMs(h: Record<string, string>): number | null {
  const v = h['retry-after']
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(n * 1000, wooConfig.maxRetryAfterMs) : null
}

/** One REST call. GETs retry within bounds; anything else is sent once. */
export async function wooRequest<T>(site: WooSite, req: WooReq, opts: { maxAttempts?: number } = {}): Promise<WooResponse<T>> {
  const method = req.method ?? 'GET'
  const read = method === 'GET'
  const maxAttempts = read ? opts.maxAttempts ?? wooConfig.readAttempts : 1
  const query = { ...(req.query ?? {}) }
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'Deploi/1.0 (+https://getdeploi.com)' }
  if (site.creds) {
    if (site.authMode === 'query') { query.consumer_key = site.creds.consumerKey; query.consumer_secret = site.creds.consumerSecret }
    else headers.authorization = `Basic ${Buffer.from(`${site.creds.consumerKey}:${site.creds.consumerSecret}`).toString('base64')}`
  }
  const body = req.body === undefined ? undefined : JSON.stringify(req.body)
  if (body !== undefined) headers['content-type'] = 'application/json'
  const url = buildUrl(site.siteUrl, req.path, query)
  for (let attempt = 1; ; attempt++) {
    let res
    try {
      res = await site.transport({ method, url, headers, body })
    } catch (e) {
      if (e instanceof WooRequestRefused) throw new WooApiError(e.message, 'rejected')
      if (attempt < maxAttempts) { await wooClientHooks.sleep(wooConfig.baseDelayMs * 2 ** (attempt - 1)); continue }
      throw new WooApiError(`no answer from the store: ${(e as Error).message.slice(0, 160)}`, 'unknown')
    }
    let json: unknown = null
    try { json = res.body ? JSON.parse(res.body) : null } catch { json = null }
    if (res.status >= 200 && res.status < 300) {
      if (json === null) throw new WooApiError(`HTTP ${res.status}: the answer is not JSON (is this a WooCommerce store with pretty permalinks?)`, 'unknown', res.status)
      return { status: res.status, headers: res.headers, data: json as T }
    }
    const err = classify(res.status, json as { code?: string; message?: string } | null)
    if (err.kind === 'unknown' && attempt < maxAttempts) {
      await wooClientHooks.sleep(retryAfterMs(res.headers) ?? wooConfig.baseDelayMs * 2 ** (attempt - 1))
      continue
    }
    throw err
  }
}

/** Every page of a collection, `per_page` 100, until `X-WP-TotalPages` (or a short page) says it is the last. */
export async function* wooPages<T>(site: WooSite, path: string, query: WooReq['query'] = {}): AsyncGenerator<T[]> {
  for (let page = 1; page <= 10000; page++) {
    const r = await wooRequest<T[]>(site, { path, query: { ...query, per_page: WC_PER_PAGE, page } })
    if (!Array.isArray(r.data)) throw new WooApiError(`expected a list from ${path}`, 'unknown', r.status)
    yield r.data
    const total = Number(r.headers['x-wp-totalpages'])
    if (Number.isFinite(total) && total > 0 ? page >= total : r.data.length < WC_PER_PAGE) return
  }
}

type MetaRow = { site_url: string; auth_mode: AuthMode }

/** The site, credentials and transport for a connection. */
export async function siteFor(conn: ConnectionRow): Promise<WooSite> {
  const { cred, meta } = await admin(async db => ({
    cred: await loadCredential(db, conn.id),
    meta: await db.one<MetaRow>('select site_url, auth_mode from woo_connections where connection_id = $1', [conn.id]),
  }))
  const siteUrl = meta?.site_url ?? conn.external_id
  const creds = cred ? decodeCreds(cred.secret) : null
  const transport = wooClientHooks.transportOverride ? wooClientHooks.transportOverride(conn)
    : conn.is_synthetic ? syntheticWooTransport(conn.id)
    : realWooTransport(new URL(siteUrl).hostname)
  if (!creds && !conn.is_synthetic) throw new WooApiError('no API key is stored for this store; connect it again', 'auth')
  // workflow cost: every real REST call to the store (lib/ai/meter.ts); synthetic stores are not counted
  const counted: typeof transport = conn.is_synthetic ? transport : (r => { countWorkflow(conn.org_id, 'provider_call', 'woocommerce'); return transport(r) })
  return { siteUrl, creds, authMode: meta?.auth_mode ?? 'basic', transport: counted }
}
