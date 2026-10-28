/**
 * One fetch helper for the merchant API, used by both the Deploi web app (/store) and the embedded
 * Shopify admin app (/shopify).
 *  - standalone: same-origin request; the signed-in session cookie authenticates it.
 *  - embedded: every request carries `Authorization: Bearer <App Bridge id token>` (a fresh token per call).
 * Bodies are sent as JSON. `{ ok:false, error, message }` responses become a typed StoreApiError.
 */
export class StoreApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'StoreApiError' }
}

type TokenSource = () => Promise<string>
let tokenSource: TokenSource | null = null

/** Embedded mode: set by the Shopify frame once App Bridge is available. Null returns to cookie mode. */
export function setEmbeddedTokenSource(fn: TokenSource | null) { tokenSource = fn }
export function isEmbedded() { return tokenSource !== null }

export type StoreInit = Omit<RequestInit, 'body'> & { body?: unknown }

export async function storeFetch<T = Record<string, unknown>>(path: string, init: StoreInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  let body: BodyInit | undefined
  if (init.body !== undefined) { headers.set('content-type', 'application/json'); body = JSON.stringify(init.body) }
  if (tokenSource) headers.set('authorization', `Bearer ${await tokenSource()}`)
  let res: Response
  try {
    res = await fetch(path, { ...init, body, headers, credentials: tokenSource ? 'omit' : 'same-origin', cache: 'no-store' })
  } catch {
    throw new StoreApiError(0, 'network', 'Could not reach Deploi. Check your connection and try again.')
  }
  let json: Record<string, unknown> | null = null
  try { json = await res.json() } catch { json = null }
  if (!res.ok || !json || json.ok === false) {
    const code = typeof json?.error === 'string' ? json.error : res.status === 404 ? 'not_found' : 'http_' + res.status
    const message = typeof json?.message === 'string' ? json.message : res.status === 404 ? 'not found' : `request failed (${res.status})`
    throw new StoreApiError(res.status, code, message)
  }
  return json as T
}

export function asApiError(e: unknown): StoreApiError {
  return e instanceof StoreApiError ? e : new StoreApiError(0, 'unexpected', (e as Error)?.message ?? 'something went wrong')
}
