/**
 * Fetching pages a merchant names (competitor stores). The URL comes from a user, so every request is
 * treated as hostile until proven otherwise:
 *  - https only, port 443 only, no credentials in the URL, no IP literals, no single-label or internal names;
 *  - every address the name resolves to must be public (no loopback, private, link-local, CGNAT,
 *    multicast, reserved, IPv4-mapped private, unique-local or documentation ranges);
 *  - the connection is made to the address that was checked (custom lookup), so a DNS answer that
 *    changes between the check and the connect (rebinding) cannot reach a private address;
 *  - redirects are followed by hand, at most 3, each one re-checked, and only within the same site
 *    (same host, or the www./bare variant of it); anything else stops with "redirected off-site";
 *  - responses are capped in size and time, and only the content types a source asks for are accepted.
 *
 * The body is returned as untrusted text. Callers parse it as data and never pass it to an LLM or treat
 * it as instructions.
 *
 * Environments that can only reach the internet through an HTTP CONNECT proxy (local sandboxes, CI) can
 * set PUBLIC_FETCH_PROXY. The name is still resolved and checked locally first. Production never uses
 * the proxy, whatever the env says.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import https from 'node:https'
import http from 'node:http'
import tls from 'node:tls'
import type { LookupFunction } from 'node:net'
import { isProductionDeployment } from '../auth-guard'

export const SAFE_FETCH_USER_AGENT = 'DeploiCompetitorWatcher/1.0 (+https://getdeploi.com/bot)'

export class FetchRefused extends Error {
  constructor(public code: 'bad_url' | 'private_address' | 'dns_failed' | 'redirect_off_site' | 'too_many_redirects' | 'too_large' | 'timeout' | 'bad_content_type' | 'network', message: string) {
    super(message); this.name = 'FetchRefused'
  }
}

export type SafeResponse = { status: number; url: string; contentType: string; body: string; headers: Record<string, string>; fetchedAt: Date }
export type SafeFetchOptions = { maxBytes?: number; timeoutMs?: number; accept?: RegExp; maxRedirects?: number }
/** What actually moves bytes; replaced in tests. Must connect only to `address`. */
export type Transport = (req: { url: URL; address: string; family: 4 | 6; timeoutMs: number; maxBytes: number }) => Promise<{ status: number; headers: Record<string, string>; body: string }>

// ------------------------------------------------------------------ address checks

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0
}
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
]
function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip)
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return (n & mask) === (v4ToInt(base) & mask)
  })
}

/** Expand an IPv6 address to 8 hextets. */
function v6Hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  // embedded IPv4 tail (::ffff:1.2.3.4)
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (m) {
    const n = v4ToInt(m[2])
    s = `${m[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const [head, tail] = s.split('::')
  const h = head ? head.split(':') : []
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : []
  if (tail === undefined && h.length !== 8) return null
  const fill = 8 - h.length - t.length
  if (fill < 0) return null
  const parts = [...h, ...Array(tail !== undefined ? fill : 0).fill('0'), ...t]
  if (parts.length !== 8) return null
  const out = parts.map(p => parseInt(p || '0', 16))
  return out.some(x => Number.isNaN(x) || x < 0 || x > 0xffff) ? null : out
}

/** True when an address must never be fetched. Unknown formats count as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, '').split('%')[0])
  if (kind === 4) return v4Blocked(ip)
  if (kind !== 6) return true
  const h = v6Hextets(ip)
  if (!h) return true
  if (h.every(x => x === 0)) return true // ::
  if (h.slice(0, 7).every(x => x === 0) && h[7] === 1) return true // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 address
  if (h.slice(0, 5).every(x => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
    const v4 = `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`
    return v4Blocked(v4)
  }
  if (h[0] === 0x64 && h[1] === 0xff9b) return true // NAT64 can reach IPv4 private space
  if ((h[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  if ((h[0] & 0xffc0) === 0xfec0) return true // fec0::/10 site local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true // documentation
  if (h[0] === 0x2002) return true // 6to4 can embed private IPv4
  if (h[0] === 0x2001 && h[1] === 0) return true // Teredo
  return false
}

/**
 * Normalize a merchant-entered store address to its https origin, or explain why it is not acceptable.
 * "Example.com/collections/x" -> "https://example.com".
 */
export function normalizeStoreUrl(input: string): { ok: true; origin: string; host: string } | { ok: false; reason: string } {
  let raw = input.trim()
  if (!raw) return { ok: false, reason: 'enter a store address' }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`
  let u: URL
  try { u = new URL(raw) } catch { return { ok: false, reason: 'not a web address' } }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'only web addresses (https) can be watched' }
  if (u.username || u.password) return { ok: false, reason: 'addresses with a username or password are not allowed' }
  if (u.port && u.port !== '443') return { ok: false, reason: 'only the standard https port is allowed' }
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (isIP(host.replace(/^\[|\]$/g, ''))) return { ok: false, reason: 'use the store’s domain name, not an IP address' }
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host)) return { ok: false, reason: 'not a public domain name' }
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host)) return { ok: false, reason: 'not a public domain name' }
  return { ok: true, origin: `https://${host}`, host }
}

/** Same site for redirects: identical host, or the www./bare pair. */
export function sameSite(a: string, b: string): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, '')
  return strip(a) === strip(b)
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>
const defaultResolver: Resolver = host => dnsLookup(host, { all: true, verbatim: true })

/** Resolve and require every answer to be public. Returns the first address (the one we connect to). */
export async function resolvePublic(host: string, resolve: Resolver = defaultResolver): Promise<{ address: string; family: 4 | 6 }> {
  let answers: { address: string; family: number }[]
  try { answers = await resolve(host) } catch (e) { throw new FetchRefused('dns_failed', `could not resolve ${host}: ${(e as Error).message.slice(0, 80)}`) }
  if (!answers.length) throw new FetchRefused('dns_failed', `${host} has no address`)
  const bad = answers.find(a => isBlockedAddress(a.address))
  if (bad) throw new FetchRefused('private_address', `${host} resolves to a non-public address; it will not be fetched`)
  return { address: answers[0].address, family: answers[0].family === 6 ? 6 : 4 }
}

// ------------------------------------------------------------------ transports

function proxyUrl(): URL | null {
  if (isProductionDeployment()) return null
  const p = (process.env.PUBLIC_FETCH_PROXY ?? '').trim()
  if (!p) return null
  try { return new URL(p) } catch { return null }
}

function collect(res: http.IncomingMessage, maxBytes: number, resolve: (v: { status: number; headers: Record<string, string>; body: string }) => void, reject: (e: Error) => void) {
  const chunks: Buffer[] = []
  let size = 0
  const declared = Number(res.headers['content-length'] ?? 0)
  if (declared > maxBytes) { res.destroy(); reject(new FetchRefused('too_large', `response is ${declared} bytes; the limit is ${maxBytes}`)); return }
  res.on('data', (c: Buffer) => {
    size += c.length
    if (size > maxBytes) { res.destroy(); reject(new FetchRefused('too_large', `response exceeded ${maxBytes} bytes`)); return }
    chunks.push(c)
  })
  res.on('end', () => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v; else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ')
    resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') })
  })
  res.on('error', e => reject(new FetchRefused('network', e.message)))
}

/** Direct connection to the checked address, with SNI and certificate checks for the real host name. */
export const directTransport: Transport = ({ url, address, family, timeoutMs, maxBytes }) => new Promise((resolve, reject) => {
  const pinned: LookupFunction = (_h, opts, cb) => {
    if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }])
    else cb(null, address, family)
  }
  const proxy = proxyUrl()
  const headers = { 'user-agent': SAFE_FETCH_USER_AGENT, accept: 'application/json, text/plain;q=0.8, */*;q=0.1', 'accept-encoding': 'identity' }
  const timer = setTimeout(() => reject(new FetchRefused('timeout', `no answer within ${timeoutMs} ms`)), timeoutMs)
  const done = { resolve: (v: Parameters<typeof resolve>[0]) => { clearTimeout(timer); resolve(v) }, reject: (e: Error) => { clearTimeout(timer); reject(e) } }
  if (!proxy) {
    const req = https.request({ host: url.hostname, servername: url.hostname, port: 443, path: url.pathname + url.search, method: 'GET', headers, lookup: pinned, timeout: timeoutMs },
      res => collect(res, maxBytes, done.resolve, done.reject))
    req.on('timeout', () => req.destroy(new FetchRefused('timeout', `no answer within ${timeoutMs} ms`)))
    req.on('error', e => done.reject(e instanceof FetchRefused ? e : new FetchRefused('network', e.message)))
    req.end()
    return
  }
  // CONNECT through the proxy to the host name (proxies usually filter by name); the name was checked above
  const connect = http.request({ host: proxy.hostname, port: Number(proxy.port || 80), method: 'CONNECT', path: `${url.hostname}:443`, timeout: timeoutMs,
    headers: proxy.username ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {} })
  connect.on('connect', (res, socket) => {
    if (res.statusCode !== 200) { socket.destroy(); done.reject(new FetchRefused('network', `proxy refused CONNECT (${res.statusCode})`)); return }
    const secure = tls.connect({ socket, servername: url.hostname })
    const req = https.request({ host: url.hostname, path: url.pathname + url.search, method: 'GET', headers, createConnection: () => secure, timeout: timeoutMs },
      r => collect(r, maxBytes, done.resolve, done.reject))
    req.on('error', e => done.reject(e instanceof FetchRefused ? e : new FetchRefused('network', e.message)))
    req.end()
  })
  connect.on('error', e => done.reject(new FetchRefused('network', e.message)))
  connect.end()
})

// ------------------------------------------------------------------ fetch

export async function safeFetch(input: string, opts: SafeFetchOptions = {}, deps: { transport?: Transport; resolve?: Resolver } = {}): Promise<SafeResponse> {
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024
  const timeoutMs = opts.timeoutMs ?? 15000
  const maxRedirects = opts.maxRedirects ?? 3
  const transport = deps.transport ?? directTransport
  const first = normalizeStoreUrl(input)
  if (!first.ok) throw new FetchRefused('bad_url', first.reason)
  let url = new URL(input.startsWith('http') ? input : `https://${input}`)
  url.protocol = 'https:'
  const originHost = first.host
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const n = normalizeStoreUrl(url.origin)
    if (!n.ok) throw new FetchRefused('bad_url', n.reason)
    if (!sameSite(n.host, originHost)) throw new FetchRefused('redirect_off_site', `redirected from ${originHost} to ${n.host}; only the same site is followed`)
    const { address, family } = await resolvePublic(n.host, deps.resolve)
    const res = await transport({ url, address, family, timeoutMs, maxBytes })
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers['location']
      if (!loc) throw new FetchRefused('network', `redirect without a location from ${url.host}`)
      const next = new URL(loc, url)
      if (next.protocol !== 'https:') throw new FetchRefused('redirect_off_site', 'redirected to a non-https address')
      url = next
      continue
    }
    const contentType = (res.headers['content-type'] ?? '').toLowerCase()
    if (res.status >= 200 && res.status < 300 && opts.accept && !opts.accept.test(contentType)) throw new FetchRefused('bad_content_type', `expected ${opts.accept.source}, got ${contentType || 'no content type'}`)
    return { status: res.status, url: url.toString(), contentType, body: res.body, headers: res.headers, fetchedAt: new Date() }
  }
  throw new FetchRefused('too_many_redirects', `more than ${maxRedirects} redirects`)
}
