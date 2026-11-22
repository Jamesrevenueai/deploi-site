/**
 * Synthetic WooCommerce store: answers the REST v3 requests this connector makes, from a JSON state, so
 * tests and demos exercise the real client and connector code (URLs, query strings, Basic auth, key
 * permissions, pagination headers, error bodies, stock-status recomputation, duplicate-SKU refusal,
 * webhooks) without touching a real merchant. Two ways to use it:
 *  - `fakeWooTransport(state)`: an in-memory HTTP layer (no database), for client and connector unit tests;
 *  - `syntheticWooTransport(connectionId)`: state kept in synthetic_store_state, for connections flagged
 *    is_synthetic (agent runs end to end, demos).
 * Fault injection covers the failure paths: 5xx, 429, resets, lost responses (applied or not), writes the
 * store silently ignores, and refusals.
 */
import { admin } from '../../db'
import type { WooHttpRequest, WooHttpResponse, WooTransport } from './http'

export type SynthWooVariation = {
  id: number; sku: string; status: 'publish' | 'private'; regular_price: string; sale_price: string; sale_scheduled?: boolean
  manage_stock: boolean | 'parent'; stock_quantity: number | null; stock_status?: string; backorders: 'no' | 'notify' | 'yes'
  low_stock_amount?: number | null; attributes: { name: string; option: string }[]; global_unique_id?: string; date_modified_gmt?: string
}
export type SynthWooProduct = {
  id: number; name: string; slug: string; type: 'simple' | 'variable' | 'grouped' | 'external'; status: 'publish' | 'draft' | 'pending' | 'private' | 'future' | 'trash'
  sku: string; regular_price: string; sale_price: string; sale_scheduled?: boolean
  manage_stock: boolean; stock_quantity: number | null; stock_status?: string; backorders: 'no' | 'notify' | 'yes'; low_stock_amount?: number | null
  tags: string[]; variations?: SynthWooVariation[]; global_unique_id?: string; date_modified_gmt?: string
}
export type SynthWooFault = {
  /** "<METHOD> <route>", e.g. "PUT /products/:id", "PUT /products/:id/variations/:vid", "GET /products" */
  op: string
  mode: 'http_500' | 'http_429' | 'network' | 'lost_response_applied' | 'lost_response_not_applied' | 'write_ignored' | 'reject_400'
  remaining: number
}
export type SynthWooKey = { consumerKey: string; consumerSecret: string; permissions: 'read' | 'write' | 'read_write' }
export type SynthWooWebhook = { id: number; name: string; topic: string; delivery_url: string; secret: string; status: string }
export type WooSynthState = {
  kind: 'woocommerce'
  site: { name: string; url: string; timezone: string; currency: string; wcVersion: string; wpVersion: string }
  settings: { manage_stock: 'yes' | 'no'; notify_low_stock_amount: number }
  /** keys the store accepts; empty = no auth check (demo stores) */
  keys: SynthWooKey[]
  products: SynthWooProduct[]
  webhooks: SynthWooWebhook[]
  faults: SynthWooFault[]
  writeLog: { at: string; op: string; path: string; body: Record<string, unknown> }[]
  /** every request seen (method, path without credentials, auth kind) for request-shape assertions */
  requestLog?: { method: string; path: string; query: Record<string, string>; auth: 'basic' | 'query' | 'none' }[]
  nextId: number
}

export class SyntheticWooNetworkError extends Error { constructor(m: string) { super(m); this.name = 'SyntheticWooNetworkError' } }

const json = (status: number, body: unknown, headers: Record<string, string> = {}): WooHttpResponse => ({ status, headers: { 'content-type': 'application/json; charset=UTF-8', ...headers }, body: JSON.stringify(body) })
const err = (status: number, code: string, message: string) => json(status, { code, message, data: { status } })

function takeFault(s: WooSynthState, op: string): SynthWooFault | null {
  const f = s.faults.find(x => x.op === op && x.remaining > 0)
  if (!f) return null
  f.remaining--
  s.faults = s.faults.filter(x => x.remaining > 0)
  return f
}

function computedStatus(manage: boolean, qty: number | null, backorders: string, fallback = 'instock'): string {
  if (!manage) return fallback
  return (qty ?? 0) > 0 ? 'instock' : backorders !== 'no' ? 'onbackorder' : 'outofstock'
}

function productJson(s: WooSynthState, p: SynthWooProduct) {
  const globalOff = s.settings.manage_stock === 'no'
  const manage = p.manage_stock && !globalOff
  const onSale = Boolean(p.sale_price) && !p.sale_scheduled
  return {
    id: p.id, name: p.name, slug: p.slug, type: p.type, status: p.status, sku: p.sku,
    price: onSale ? p.sale_price : p.regular_price, regular_price: p.regular_price, sale_price: p.sale_price, on_sale: onSale,
    manage_stock: manage, stock_quantity: manage ? p.stock_quantity : null, backorders: manage ? p.backorders : 'no',
    stock_status: p.stock_status ?? computedStatus(manage, p.stock_quantity, p.backorders), low_stock_amount: manage ? p.low_stock_amount ?? null : null,
    tags: p.tags.map((name, i) => ({ id: i + 1, name, slug: name.toLowerCase().replace(/\s+/g, '-') })),
    variations: (p.variations ?? []).map(v => v.id), global_unique_id: p.global_unique_id ?? '', date_modified_gmt: p.date_modified_gmt ?? '2026-10-01T00:00:00',
  }
}

function variationJson(s: WooSynthState, p: SynthWooProduct, v: SynthWooVariation) {
  const parentManages = p.manage_stock && s.settings.manage_stock !== 'no'
  const inherits = v.manage_stock !== true && parentManages
  const manage: boolean | 'parent' = v.manage_stock === true ? true : inherits ? 'parent' : false
  const qty = manage === true ? v.stock_quantity : inherits ? p.stock_quantity : null
  const backorders = manage === true ? v.backorders : inherits ? p.backorders : 'no'
  const onSale = Boolean(v.sale_price) && !v.sale_scheduled
  return {
    id: v.id, parent_id: p.id, sku: v.sku, status: v.status, price: onSale ? v.sale_price : v.regular_price, regular_price: v.regular_price, sale_price: v.sale_price, on_sale: onSale,
    manage_stock: manage, stock_quantity: qty, backorders, stock_status: v.stock_status ?? computedStatus(manage !== false, qty, backorders),
    low_stock_amount: v.low_stock_amount ?? null, attributes: v.attributes, global_unique_id: v.global_unique_id ?? '', date_modified_gmt: v.date_modified_gmt ?? '2026-10-01T00:00:00',
  }
}

function page<T>(items: T[], q: URLSearchParams): WooHttpResponse {
  const per = Math.min(Math.max(Number(q.get('per_page') ?? 10), 1), 100)
  const n = Math.max(Number(q.get('page') ?? 1), 1)
  const total = items.length
  const pages = Math.max(Math.ceil(total / per), 1)
  return json(200, items.slice((n - 1) * per, n * per), { 'x-wp-total': String(total), 'x-wp-totalpages': String(pages) })
}

function authOf(s: WooSynthState, req: WooHttpRequest, q: URLSearchParams): { kind: 'basic' | 'query' | 'none'; key: SynthWooKey | null } {
  const h = req.headers.authorization ?? req.headers.Authorization
  if (h && /^Basic /.test(h)) {
    const [ck, cs] = Buffer.from(h.slice(6), 'base64').toString().split(':')
    return { kind: 'basic', key: s.keys.find(k => k.consumerKey === ck && k.consumerSecret === cs) ?? null }
  }
  if (q.get('consumer_key')) return { kind: 'query', key: s.keys.find(k => k.consumerKey === q.get('consumer_key') && k.consumerSecret === q.get('consumer_secret')) ?? null }
  return { kind: 'none', key: null }
}

const now = () => new Date().toISOString().slice(0, 19)

/** Handle one HTTP request against a state. May throw SyntheticWooNetworkError (a lost connection). */
export function handleSyntheticWoo(s: WooSynthState, req: WooHttpRequest): { res: WooHttpResponse; changed: boolean } {
  const url = new URL(req.url)
  const q = url.searchParams
  const base = new URL(s.site.url).pathname.replace(/\/+$/, '')
  const path = url.pathname.slice(base.length)
  const auth = authOf(s, req, q)
  const logQuery: Record<string, string> = {}
  for (const [k, v] of q) if (k !== 'consumer_key' && k !== 'consumer_secret') logQuery[k] = v
  s.requestLog = [...(s.requestLog ?? []).slice(-199), { method: req.method, path, query: logQuery, auth: auth.kind }]
  if (path === '/wp-json/' || path === '/wp-json') return { res: json(200, { name: s.site.name, url: s.site.url, timezone_string: s.site.timezone, namespaces: ['wc/v3'] }), changed: true }
  const m = /^\/wp-json\/wc\/v3(\/.*)$/.exec(path)
  if (!m) return { res: err(404, 'rest_no_route', 'No route was found matching the URL and request method.'), changed: true }
  const route = m[1]
  const write = req.method !== 'GET'
  if (s.keys.length) {
    if (!auth.key) return { res: err(401, 'woocommerce_rest_authentication_error', 'Invalid signature - provided signature does not match.'), changed: true }
    if (write && auth.key.permissions === 'read') return { res: err(401, 'woocommerce_rest_authentication_error', 'The API key provided does not have write permissions.'), changed: true }
    if (!write && auth.key.permissions === 'write') return { res: err(401, 'woocommerce_rest_authentication_error', 'The API key provided does not have read permissions.'), changed: true }
  }
  const tpl = route.replace(/\/variations\/\d+/, '/variations/:vid').replace(/\/products\/\d+/, '/products/:id').replace(/\/webhooks\/\d+/, '/webhooks/:id')
  const op = `${req.method} ${tpl}`
  const fault = takeFault(s, op)
  if (fault?.mode === 'http_500') return { res: err(500, 'internal_server_error', 'There has been a critical error on this website.'), changed: true }
  if (fault?.mode === 'http_429') return { res: { ...err(429, 'too_many_requests', 'Too many requests.'), headers: { 'retry-after': '0' } }, changed: true }
  if (fault?.mode === 'network') throw new SyntheticWooNetworkError('connection reset (synthetic)')
  if (fault?.mode === 'reject_400') return { res: err(400, 'woocommerce_rest_invalid_request', 'The store refused the change (synthetic refusal).'), changed: true }

  if (req.method === 'GET' && route === '/system_status') return { res: json(200, { environment: { version: s.site.wcVersion, wp_version: s.site.wpVersion, site_url: s.site.url }, settings: { currency: s.site.currency } }), changed: true }
  const setting = /^\/settings\/(products|general)\/([a-z_]+)$/.exec(route)
  if (req.method === 'GET' && setting) {
    const id = setting[2]
    const value = id === 'woocommerce_manage_stock' ? s.settings.manage_stock : id === 'woocommerce_notify_low_stock_amount' ? String(s.settings.notify_low_stock_amount) : id === 'woocommerce_currency' ? s.site.currency : null
    if (value === null) return { res: err(404, 'rest_setting_setting_invalid', 'Invalid setting.'), changed: true }
    return { res: json(200, { id, value }), changed: true }
  }
  if (req.method === 'GET' && route === '/products') {
    const status = q.get('status') ?? 'any'
    let list = s.products.filter(p => (status === 'any' ? p.status !== 'trash' : p.status === status))
    const sku = q.get('sku')
    if (sku) list = list.filter(p => sku.split(',').includes(p.sku))
    return { res: page([...list].sort((a, b) => a.id - b.id).map(p => productJson(s, p)), q), changed: true }
  }
  const pm = /^\/products\/(\d+)(?:\/variations(?:\/(\d+))?)?$/.exec(route)
  if (pm) {
    const p = s.products.find(x => x.id === Number(pm[1]))
    if (!p) return { res: err(404, 'woocommerce_rest_product_invalid_id', 'Invalid ID.'), changed: true }
    const isVariations = route.includes('/variations')
    const v = pm[2] ? (p.variations ?? []).find(x => x.id === Number(pm[2])) : null
    if (pm[2] && !v) return { res: err(404, 'woocommerce_rest_product_variation_invalid_id', 'Invalid ID.'), changed: true }
    if (req.method === 'GET') {
      if (isVariations && !pm[2]) return { res: page([...(p.variations ?? [])].sort((a, b) => a.id - b.id).map(x => variationJson(s, p, x)), q), changed: true }
      return { res: json(200, v ? variationJson(s, p, v) : productJson(s, p)), changed: true }
    }
    if (req.method === 'PUT' && (!isVariations || v)) {
      let body: Record<string, unknown>
      try { body = JSON.parse(req.body ?? '{}') } catch { return { res: err(400, 'rest_invalid_json', 'Invalid JSON body passed.'), changed: true } }
      const target = (v ?? p) as SynthWooProduct | SynthWooVariation
      // validation as WooCommerce does it
      if ('backorders' in body && !['no', 'notify', 'yes'].includes(String(body.backorders))) return { res: err(400, 'rest_invalid_param', 'Invalid parameter(s): backorders'), changed: true }
      if ('status' in body && (v ? !['publish', 'private'].includes(String(body.status)) : !['draft', 'pending', 'private', 'publish'].includes(String(body.status)))) return { res: err(400, 'rest_invalid_param', 'Invalid parameter(s): status'), changed: true }
      if ('sku' in body) {
        const sku = String(body.sku)
        const taken = s.products.some(x => (x.sku === sku && x !== target) || (x.variations ?? []).some(y => y.sku === sku && y !== target))
        if (sku && taken) return { res: err(400, 'product_invalid_sku', 'Invalid or duplicated SKU.'), changed: true }
      }
      for (const k of ['regular_price', 'sale_price']) if (k in body && body[k] !== '' && !/^\d+(\.\d+)?$/.test(String(body[k]))) return { res: err(400, 'rest_invalid_param', `Invalid parameter(s): ${k}`), changed: true }
      if (fault?.mode === 'lost_response_not_applied') throw new SyntheticWooNetworkError('response lost before the write (synthetic)')
      const ignored = fault?.mode === 'write_ignored' || ('backorders' in body && !v && s.settings.manage_stock === 'no')
      if (!ignored) {
        const t = target as Record<string, unknown>
        for (const k of ['backorders', 'regular_price', 'sale_price', 'sku', 'status']) if (k in body) t[k] = String(body[k])
        delete t.stock_status // recomputed on save, as WooCommerce does
        t.date_modified_gmt = now()
      }
      s.writeLog.push({ at: new Date().toISOString(), op, path: route, body })
      if (fault?.mode === 'lost_response_applied') throw new SyntheticWooNetworkError('response lost after the write (synthetic)')
      return { res: json(200, v ? variationJson(s, p, v) : productJson(s, p)), changed: true }
    }
  }
  if (route === '/webhooks' && req.method === 'POST') {
    const b = JSON.parse(req.body ?? '{}') as Partial<SynthWooWebhook>
    if (!b.topic || !b.delivery_url || !String(b.delivery_url).startsWith('https://')) return { res: err(400, 'rest_invalid_param', 'Invalid parameter(s): delivery_url'), changed: true }
    const hook: SynthWooWebhook = { id: s.nextId++, name: String(b.name ?? ''), topic: b.topic, delivery_url: b.delivery_url, secret: String(b.secret ?? ''), status: 'active' }
    s.webhooks.push(hook)
    return { res: json(201, { ...hook, secret: undefined }), changed: true }
  }
  if (route === '/webhooks' && req.method === 'GET') return { res: page(s.webhooks.map(h => ({ ...h, secret: undefined })), q), changed: true }
  const wm = /^\/webhooks\/(\d+)$/.exec(route)
  if (wm && req.method === 'DELETE') {
    const i = s.webhooks.findIndex(h => h.id === Number(wm[1]))
    if (i < 0) return { res: err(404, 'woocommerce_rest_webhook_invalid_id', 'Invalid ID.'), changed: true }
    const [h] = s.webhooks.splice(i, 1)
    return { res: json(200, { ...h, secret: undefined }), changed: true }
  }
  return { res: err(404, 'rest_no_route', 'No route was found matching the URL and request method.'), changed: true }
}

/** In-memory HTTP layer over a state object (no database). Mutates `state`. */
export function fakeWooTransport(state: WooSynthState): WooTransport {
  return async req => handleSyntheticWoo(state, req).res
}

export async function getWooSyntheticState(connectionId: string): Promise<WooSynthState | null> {
  return admin(async db => (await db.one<{ state: WooSynthState }>('select state from synthetic_store_state where connection_id = $1', [connectionId]))?.state ?? null)
}
export async function setWooSyntheticState(connectionId: string, state: WooSynthState) {
  await admin(db => db.query(`insert into synthetic_store_state (connection_id, state) values ($1,$2) on conflict (connection_id) do update set state = excluded.state, updated_at = now()`, [connectionId, JSON.stringify(state)]))
}
/** Change the synthetic store outside Deploi (what the merchant or another plugin would do). */
export async function mutateWooSynthetic(connectionId: string, fn: (s: WooSynthState) => void) {
  await admin(async db => {
    const r = await db.one<{ state: WooSynthState }>('select state from synthetic_store_state where connection_id = $1 for update', [connectionId])
    if (!r || r.state.kind !== 'woocommerce') throw new Error('no synthetic WooCommerce store for this connection')
    fn(r.state)
    await db.query('update synthetic_store_state set state = $2, updated_at = now() where connection_id = $1', [connectionId, JSON.stringify(r.state)])
  })
}
export async function injectWooFault(connectionId: string, fault: Omit<SynthWooFault, 'remaining'> & { remaining?: number }) {
  await mutateWooSynthetic(connectionId, s => { s.faults.push({ remaining: 1, ...fault }) })
}

/** Transport bound to one synthetic connection: each request runs in its own locked transaction. */
export function syntheticWooTransport(connectionId: string): WooTransport {
  return async req => {
    let lost: Error | null = null
    const res = await admin(async db => {
      const r = await db.one<{ state: WooSynthState }>('select state from synthetic_store_state where connection_id = $1 for update', [connectionId])
      if (!r || r.state.kind !== 'woocommerce') throw new Error('no synthetic WooCommerce store for this connection')
      let out: { res: WooHttpResponse | null; changed: boolean }
      try { out = handleSyntheticWoo(r.state, req) } catch (e) {
        if (!(e instanceof SyntheticWooNetworkError)) throw e
        lost = e
        out = { res: null, changed: true }
      }
      if (out.changed) await db.query('update synthetic_store_state set state = $2, updated_at = now() where connection_id = $1', [connectionId, JSON.stringify(r.state)])
      return out.res
    })
    if (lost) throw lost
    return res!
  }
}
