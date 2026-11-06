/** Read-side HTTP for inbox readers: one error type that tells the sync what to do next. */
import { emailFetch } from '../adapters/http'

/**
 * auth: the token was refused (401) or the read scope is missing (403 insufficient permissions): reconnect.
 * throttled: 429 / quota (retry after a delay). transient: 5xx or no response (retry with backoff).
 * gone: the stored cursor expired (Gmail history 404, Graph delta 410): resync from scratch.
 * bad: anything else (the request itself is wrong; logged, retried later).
 */
export class ReadError extends Error {
  constructor(public kind: 'auth' | 'throttled' | 'transient' | 'gone' | 'bad', public status: number, message: string, public retryAfterSec: number | null = null) { super(message); this.name = 'ReadError' }
}

const MAX_BODY = 6_000_000

export async function readJson(url: string, token: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; goneOn?: number[] } = {}): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await emailFetch(url, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
  } catch (e) { throw new ReadError('transient', 0, `no response from the provider (${(e as Error).name})`) }
  const ra = Number(res.headers.get('retry-after'))
  const retryAfter = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : null
  if (res.ok) {
    if (res.status === 202 || res.status === 204) return {}
    const len = Number(res.headers.get('content-length'))
    if (Number.isFinite(len) && len > MAX_BODY) throw new ReadError('bad', res.status, 'the provider response is too large')
    const t = await res.text().catch(() => '')
    if (t.length > MAX_BODY) throw new ReadError('bad', res.status, 'the provider response is too large')
    try { return t ? (JSON.parse(t) as Record<string, unknown>) : {} } catch { throw new ReadError('bad', res.status, 'the provider sent a response that is not JSON') }
  }
  const body = await res.text().catch(() => '')
  if (init.goneOn?.includes(res.status)) throw new ReadError('gone', res.status, 'the sync position expired')
  if (res.status === 401) throw new ReadError('auth', 401, 'the provider refused the connection; reconnect the account')
  if (res.status === 429) throw new ReadError('throttled', 429, 'rate limited by the provider', retryAfter ?? 60)
  if (res.status === 403 && /rate ?limit|quota/i.test(body)) throw new ReadError('throttled', 403, 'quota reached at the provider', retryAfter ?? 120)
  if (res.status === 403 && /insufficient|scope|permission|consent|access ?denied|ErrorAccessDenied/i.test(body)) throw new ReadError('auth', 403, 'the read permission is missing; reconnect and allow reading the inbox')
  if (res.status >= 500) throw new ReadError('transient', res.status, `the provider had an error (${res.status})`, retryAfter)
  throw new ReadError('bad', res.status, `the provider refused the request (${res.status})`)
}
