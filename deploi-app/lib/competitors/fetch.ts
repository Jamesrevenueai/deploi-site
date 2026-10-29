/**
 * The only way the competitor watcher reaches the internet. Every request:
 *  - goes to a public https host approved for "competitor_public" (lib/net/outbound.ts), re-checked on
 *    every redirect, so a redirect cannot lead to a private address or another host;
 *  - says who we are (User-Agent), never sends cookies or credentials;
 *  - waits at least COMPETITOR_MIN_INTERVAL_MS (default 1000 ms) after the previous request to that host;
 *  - stops after 10 seconds and reads at most 5 MB.
 * Tests and the synthetic demo replace the transport with setCompetitorFetch / the synthetic stores.
 */
import { assertApprovedHost } from '../net/outbound'
import { USER_AGENT } from './robots'

export type Transport = (url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>
export type FetchResult = { url: string; status: number; body: string; contentType: string } | { url: string; status: 0; body: ''; contentType: ''; error: string }

let override: Transport | null = null
/** Tests: replace the network for every competitor request (null restores it). */
export function setCompetitorFetch(t: Transport | null) { override = t }
export const competitorFetchOverridden = () => override !== null

const MAX_BYTES = 5 * 1024 * 1024
const TIMEOUT_MS = 10_000
const last = new Map<string, number>()
const minInterval = () => Math.max(0, Number(process.env.COMPETITOR_MIN_INTERVAL_MS ?? 1000) || 0)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export class PoliteFetcher {
  requests = 0
  constructor(private transport: Transport | null = null) {}

  async get(url: string, accept = 'application/json'): Promise<FetchResult> {
    let current = url
    for (let hop = 0; hop < 4; hop++) {
      try { assertApprovedHost(current, 'competitor_public') } catch (e) { return { url: current, status: 0, body: '', contentType: '', error: (e as Error).message } }
      const host = new URL(current).hostname
      const wait = (last.get(host) ?? 0) + minInterval() - Date.now()
      if (wait > 0) await sleep(wait)
      last.set(host, Date.now())
      this.requests++
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
      try {
        const t = this.transport ?? override ?? ((u, i) => fetch(u, i))
        const res = await t(current, { headers: { 'user-agent': USER_AGENT, accept }, redirect: 'manual', signal: ctl.signal })
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          current = new URL(res.headers.get('location')!, current).toString()
          continue
        }
        const len = Number(res.headers.get('content-length') ?? 0)
        if (len > MAX_BYTES) return { url: current, status: 0, body: '', contentType: '', error: 'response too large' }
        const body = await res.text()
        if (body.length > MAX_BYTES) return { url: current, status: 0, body: '', contentType: '', error: 'response too large' }
        return { url: current, status: res.status, body, contentType: res.headers.get('content-type') ?? '' }
      } catch (e) {
        return { url: current, status: 0, body: '', contentType: '', error: (e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message.slice(0, 160) }
      } finally { clearTimeout(timer) }
    }
    return { url: current, status: 0, body: '', contentType: '', error: 'too many redirects' }
  }
}
