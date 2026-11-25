/** A fake provider HTTP layer for the connection clients: records every request and answers from a handler. No real call is ever made. */
import { setOfficeFetch, setOfficeSleep } from '../../lib/office/http'
import type { TokenSource } from '../../lib/office/token'

export type Call = { url: URL; method: string; headers: Headers; body: string | null; json: unknown; form: URLSearchParams | null }
export const calls: Call[] = []
export const waits: number[] = []

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

export function fake(answer: (c: Call, n: number) => Response | Promise<Response>) {
  setOfficeSleep(async ms => { waits.push(ms) })
  setOfficeFetch(async (url, init) => {
    const body = typeof init.body === 'string' ? init.body : null
    const headers = new Headers(init.headers)
    let parsed: unknown = null
    try { parsed = body ? JSON.parse(body) : null } catch { parsed = null }
    const c: Call = { url: new URL(url), method: String(init.method ?? 'GET'), headers, body, json: parsed, form: headers.get('content-type')?.includes('form') && body !== null ? new URLSearchParams(body) : null }
    calls.push(c)
    return answer(c, calls.length)
  })
}
export function resetFake() { setOfficeFetch(null); setOfficeSleep(null); calls.length = 0; waits.length = 0 }

/** A token source that hands out access-1, and access-2 after a refresh (records each refresh). */
export function tokens(): TokenSource & { refreshed: string[] } {
  let n = 1
  const refreshed: string[] = []
  return { refreshed, get: async () => `access-${n}`, refresh: async rejected => { refreshed.push(rejected); n++; return `access-${n}` } }
}
export const path = (c: Call) => `${c.url.origin}${c.url.pathname}`
