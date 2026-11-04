/**
 * The bytes-on-the-wire layer for real WooCommerce stores. A store address comes from a merchant, so
 * every request is checked as if hostile:
 *  - https only, to the host approved for the connection (lib/net/outbound.ts, purpose "woocommerce");
 *  - every address the host resolves to must be public (lib/net/safe-fetch.ts rules), and the socket
 *    connects to the address that was checked, so DNS rebinding cannot reach a private network;
 *  - no redirects are followed (a redirect is reported, never chased with credentials attached);
 *  - bounded time and response size.
 * Environments that can only reach the internet through an HTTP CONNECT proxy may set
 * PUBLIC_FETCH_PROXY (ignored in production), exactly like the competitor fetcher.
 */
import https from 'node:https'
import http from 'node:http'
import tls from 'node:tls'
import type { LookupFunction } from 'node:net'
import { assertApprovedHost } from '../../net/outbound'
import { resolvePublic, FetchRefused, type Resolver } from '../../net/safe-fetch'
import { isProductionDeployment } from '../../auth-guard'
import { wooConfig } from './config'

export type WooMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'
export type WooHttpRequest = { method: WooMethod; url: string; headers: Record<string, string>; body?: string }
export type WooHttpResponse = { status: number; headers: Record<string, string>; body: string }
export type WooTransport = (req: WooHttpRequest) => Promise<WooHttpResponse>

/** Raised before any byte is sent when the destination is not acceptable. */
export class WooRequestRefused extends Error { constructor(message: string) { super(message); this.name = 'WooRequestRefused' } }

/** What opens the socket; replaced in tests so nothing ever leaves the machine. Must connect only to `address`. */
export type Connect = (req: WooHttpRequest & { address: string; family: 4 | 6; timeoutMs: number; maxBytes: number }) => Promise<WooHttpResponse>

function proxyUrl(): URL | null {
  if (isProductionDeployment()) return null
  const p = (process.env.PUBLIC_FETCH_PROXY ?? '').trim()
  if (!p) return null
  try { return new URL(p) } catch { return null }
}

function collect(res: http.IncomingMessage, maxBytes: number, resolve: (v: WooHttpResponse) => void, reject: (e: Error) => void) {
  const chunks: Buffer[] = []
  let size = 0
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

/** Direct connection to the checked address, with SNI and certificate verification for the real host name. */
export const pinnedConnect: Connect = ({ method, url: raw, headers, body, address, family, timeoutMs, maxBytes }) => new Promise((resolve, reject) => {
  const url = new URL(raw)
  const pinned: LookupFunction = (_h, opts, cb) => {
    if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }])
    else cb(null, address, family)
  }
  const timer = setTimeout(() => reject(new FetchRefused('timeout', `no answer within ${timeoutMs} ms`)), timeoutMs)
  const done = { resolve: (v: WooHttpResponse) => { clearTimeout(timer); resolve(v) }, reject: (e: Error) => { clearTimeout(timer); reject(e) } }
  const h = { ...headers, 'accept-encoding': 'identity', ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}) }
  const proxy = proxyUrl()
  const send = (req: http.ClientRequest) => {
    req.on('timeout', () => req.destroy(new FetchRefused('timeout', `no answer within ${timeoutMs} ms`)))
    req.on('error', e => done.reject(e instanceof FetchRefused ? e : new FetchRefused('network', e.message)))
    if (body !== undefined) req.write(body)
    req.end()
  }
  if (!proxy) {
    send(https.request({ host: url.hostname, servername: url.hostname, port: 443, path: url.pathname + url.search, method, headers: h, lookup: pinned, timeout: timeoutMs },
      res => collect(res, maxBytes, done.resolve, done.reject)))
    return
  }
  const connect = http.request({ host: proxy.hostname, port: Number(proxy.port || 80), method: 'CONNECT', path: `${url.hostname}:443`, timeout: timeoutMs,
    headers: proxy.username ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {} })
  connect.on('connect', (res, socket) => {
    if (res.statusCode !== 200) { socket.destroy(); done.reject(new FetchRefused('network', `proxy refused CONNECT (${res.statusCode})`)); return }
    const secure = tls.connect({ socket, servername: url.hostname })
    send(https.request({ host: url.hostname, path: url.pathname + url.search, method, headers: h, createConnection: () => secure, timeout: timeoutMs },
      r => collect(r, maxBytes, done.resolve, done.reject)))
  })
  connect.on('error', e => done.reject(new FetchRefused('network', e.message)))
  connect.end()
})

/**
 * Transport for one store. `siteHost` is the connection's host: a request for any other host is refused,
 * so a stored URL can never be turned into a request elsewhere.
 */
export function realWooTransport(siteHost: string, deps: { resolve?: Resolver; connect?: Connect; timeoutMs?: number; maxBytes?: number } = {}): WooTransport {
  return async req => {
    let host: string
    try { host = assertApprovedHost(req.url, 'woocommerce') } catch (e) { throw new WooRequestRefused((e as Error).message) }
    if (host !== siteHost.toLowerCase()) throw new WooRequestRefused(`request to ${host} refused: this connection may only reach ${siteHost}`)
    let addr: { address: string; family: 4 | 6 }
    try { addr = await resolvePublic(host, deps.resolve) } catch (e) {
      if (e instanceof FetchRefused && e.code === 'private_address') throw new WooRequestRefused(e.message)
      throw e
    }
    return (deps.connect ?? pinnedConnect)({ ...req, ...addr, timeoutMs: deps.timeoutMs ?? wooConfig.requestTimeoutMs, maxBytes: deps.maxBytes ?? wooConfig.maxResponseBytes })
  }
}
