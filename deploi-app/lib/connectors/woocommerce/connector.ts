/**
 * WooCommerce connector: reads products and variations (stock, backorders, prices, SKUs, status) through
 * REST v3 and performs the supported corrections. Each write is one field on one product or variation
 * (PUT with a one-key body), so every approved change is written and audited alone. The connector
 * enforces the writable fields it is given, independently of the engine, derives the request path from
 * the target id (never from free-form parameters), and never sends a write twice: a lost answer is
 * "unknown" and the engine's fresh read settles it. WooCommerce has no optimistic locking, so fresh reads
 * bypass the optional REST response cache (`_skip_cache`).
 */
import type { ApplyResult, Connector, ConnectionRow, Correction, LookupKeys } from '../../engine/types'
import { siteFor, wooPages, wooRequest, WooApiError, type WooSite } from './client'
import { normalizeProduct, normalizeVariation, type WooProductJson, type WooStoreSettings, type WooVariationJson } from './normalize'
import { READ_SCOPES, WOO_STOREFRONT, WRITE_SCOPE } from './config'
import { WOO_SET_BACKORDERS, type WooStockRecord } from './checks'
import { WOO_PUBLISH, WOO_UNPUBLISH, WOO_SET_PRICE, WOO_SET_COMPARE_AT, WOO_SET_SKU } from './listing-checks'

/** The record field each action writes; a correction outside `allowedFields` is refused before any request. */
export const ACTION_WRITES: Record<string, string> = {
  [WOO_SET_BACKORDERS]: 'backorders',
  [WOO_PUBLISH]: 'published',
  [WOO_UNPUBLISH]: 'published',
  [WOO_SET_PRICE]: 'price',
  [WOO_SET_COMPARE_AT]: 'compareAtPrice',
  [WOO_SET_SKU]: 'sku',
}
export const ACTION_SCOPES: Record<string, string[]> = Object.fromEntries(Object.keys(ACTION_WRITES).map(k => [k, [WRITE_SCOPE]]))

const isMoney = (v: unknown) => typeof v === 'string' && /^\d{1,9}\.\d{2}$/.test(v)
type Target = { productId: number; variationId: number | null; path: string }

/** "product:12" or "variation:12:34" -> ids and the one REST path that object lives at. */
export function parseTarget(id: string): Target | null {
  const p = /^product:(\d{1,18})$/.exec(id)
  if (p) return { productId: Number(p[1]), variationId: null, path: `/products/${Number(p[1])}` }
  const v = /^variation:(\d{1,18}):(\d{1,18})$/.exec(id)
  if (v) return { productId: Number(v[1]), variationId: Number(v[2]), path: `/products/${Number(v[1])}/variations/${Number(v[2])}` }
  return null
}

const FRESH = () => ({ _skip_cache: 1, _deploi: Date.now().toString(36) })

/** Store-wide inventory settings; unreadable settings are null (checks then make no store-wide assumption). */
export async function readStoreSettings(site: WooSite): Promise<WooStoreSettings> {
  const get = async (group: string, id: string) => {
    try { return String((await wooRequest<{ value?: unknown }>(site, { path: `/settings/${group}/${id}` }, { maxAttempts: 2 })).data.value ?? '') } catch { return null }
  }
  const [manage, low, currency] = [await get('products', 'woocommerce_manage_stock'), await get('products', 'woocommerce_notify_low_stock_amount'), await get('general', 'woocommerce_currency')]
  return {
    manageStock: manage === 'yes' ? true : manage === 'no' ? false : null,
    lowStockAmount: low !== null && /^\d+$/.test(low) ? Number(low) : null,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
  }
}

async function readProductTree(site: WooSite, settings: WooStoreSettings, p: WooProductJson, out: WooStockRecord[], fresh: boolean) {
  const fetchedAt = new Date().toISOString()
  const parent = normalizeProduct(p, settings, fetchedAt)
  out.push(parent)
  if (parent.type !== 'variable' || !(p.variations ?? []).length) return
  for await (const vs of wooPages<WooVariationJson>(site, `/products/${p.id}/variations`, { orderby: 'id', order: 'asc', ...(fresh ? FRESH() : {}) }))
    for (const v of vs) out.push(normalizeVariation(parent, v, new Date().toISOString()))
}

async function* catalogue(conn: ConnectionRow): AsyncGenerator<WooStockRecord[]> {
  const site = await siteFor(conn)
  const settings = await readStoreSettings(site)
  for await (const products of wooPages<WooProductJson>(site, '/products', { status: 'any', orderby: 'id', order: 'asc' })) {
    const out: WooStockRecord[] = []
    for (const p of products) await readProductTree(site, settings, p, out, false)
    yield out
  }
}

function refused(request: Record<string, unknown>, error: string, blocked = true): ApplyResult {
  return { outcome: 'rejected', request, response: null, error, blocked }
}

const PICK = ['id', 'status', 'sku', 'regular_price', 'sale_price', 'on_sale', 'backorders', 'stock_status', 'manage_stock', 'date_modified_gmt']

async function put(site: WooSite, t: Target, body: Record<string, unknown>, base: Record<string, unknown>): Promise<ApplyResult> {
  const request = { ...base, method: 'PUT', path: t.path, body }
  try {
    const r = await wooRequest<Record<string, unknown>>(site, { method: 'PUT', path: t.path, body })
    const response = Object.fromEntries(PICK.filter(k => k in r.data).map(k => [k, r.data[k]]))
    const [field, value] = Object.entries(body)[0]
    // WooCommerce answers 200 even when it ignores a field (e.g. backorders while stock management is off store-wide)
    const shown = String(r.data[field] ?? '') === String(value)
    return { outcome: 'applied', request, response, ...(shown ? {} : { error: `the store answered but its response does not show ${field} = ${String(value)}` }) }
  } catch (e) {
    const err = e as WooApiError
    // an auth error, a missing record or a validation refusal is a definite "no"; anything else has no definite answer
    if (err instanceof WooApiError && err.kind !== 'unknown') return { outcome: 'rejected', request, response: err.code ? { code: err.code, status: err.status ?? null } : null, error: err.message }
    return { outcome: 'unknown', request, response: null, error: (e as Error).message.slice(0, 300) }
  }
}

export const wooConnector: Connector<WooStockRecord> = {
  platform: 'woocommerce',
  operational: true,
  requiredScopes: { read: READ_SCOPES, actions: ACTION_SCOPES },

  listResources: catalogue,

  async readResources(conn, ids) {
    const groups = new Map<number, { whole: boolean; variations: Set<number> }>()
    for (const id of ids) {
      const t = parseTarget(id)
      if (!t) continue
      const g = groups.get(t.productId) ?? { whole: false, variations: new Set<number>() }
      if (t.variationId === null) g.whole = true; else g.variations.add(t.variationId)
      groups.set(t.productId, g)
    }
    const out = new Map<string, WooStockRecord>()
    if (!groups.size) return out
    const site = await siteFor(conn)
    const settings = await readStoreSettings(site)
    for (const [productId, g] of groups) {
      let p: WooProductJson
      try { p = (await wooRequest<WooProductJson>(site, { path: `/products/${productId}`, query: FRESH() })).data } catch (e) {
        if (e instanceof WooApiError && e.kind === 'not_found') continue
        throw e
      }
      if (p.status === 'trash') continue
      const recs: WooStockRecord[] = []
      if (g.whole) await readProductTree(site, settings, p, recs, true)
      else {
        const parent = normalizeProduct(p, settings, new Date().toISOString())
        recs.push(parent)
        for (const vid of g.variations) {
          try { recs.push(normalizeVariation(parent, (await wooRequest<WooVariationJson>(site, { path: `/products/${productId}/variations/${vid}`, query: FRESH() })).data, new Date().toISOString())) } catch (e) {
            if (!(e instanceof WooApiError && e.kind === 'not_found')) throw e
          }
        }
      }
      for (const r of recs) out.set(r.resourceId, r)
    }
    return out
  },

  /** WooCommerce has no store-wide lookup that covers variation SKUs, so lookups read the catalogue and filter it. */
  async findResources(conn, keys: LookupKeys) {
    const skus = new Set(keys.skus.map(s => s.trim().toLowerCase()))
    const barcodes = new Set(keys.barcodes.map(b => b.trim()))
    const handles = new Set(keys.handles.map(h => h.trim().toLowerCase()))
    const out: WooStockRecord[] = []
    for await (const page of catalogue(conn)) for (const r of page) {
      if ((r.sku && skus.has(r.sku.toLowerCase())) || (r.barcodes ?? []).some(b => barcodes.has(b)) || (r.productHandle && handles.has(r.productHandle.toLowerCase()))) out.push(r)
    }
    return out
  },

  async applyAction(conn, c: Correction, allowedFields?: string[]): Promise<ApplyResult> {
    const base = { actionKey: c.actionKey, targetId: c.targetId }
    const writes = ACTION_WRITES[c.actionKey]
    if (!writes) return refused(base, `unsupported action ${c.actionKey}`)
    if (allowedFields && !allowedFields.includes(writes)) return refused(base, `field "${writes}" is not writable under this authorization`)
    const t = parseTarget(c.targetId)
    if (!t) return refused(base, 'invalid correction parameters')
    if (c.params?.path !== undefined && c.params.path !== t.path) return refused(base, 'invalid correction parameters')
    let site: WooSite
    try { site = await siteFor(conn) } catch (e) { return refused(base, (e as Error).message) }

    if (c.actionKey === WOO_SET_BACKORDERS) {
      const to = String(c.change.to)
      if (c.change.field !== 'backorders' || !['no', 'notify', 'yes'].includes(to)) return refused(base, 'invalid correction parameters')
      return put(site, t, { backorders: to }, base)
    }

    if (c.actionKey === WOO_PUBLISH || c.actionKey === WOO_UNPUBLISH) {
      const publish = c.actionKey === WOO_PUBLISH
      if (t.variationId !== null || c.change.field !== `published.${WOO_STOREFRONT}` || c.change.to !== publish) return refused(base, 'invalid correction parameters')
      // only ever draft <-> publish: re-read the status right before writing, never touching pending, private, scheduled or trashed products
      const expected = publish ? 'draft' : 'publish'
      let status: string
      try { status = String((await wooRequest<WooProductJson>(site, { path: t.path, query: FRESH() })).data.status ?? '') } catch (e) { return refused(base, `could not re-read the product status before writing: ${(e as Error).message.slice(0, 120)}`) }
      if (status !== expected) return refused(base, `the product is now ${status || 'unreadable'}; Deploi only moves products between draft and published`)
      return put(site, t, { status: publish ? 'publish' : 'draft' }, base)
    }

    if (c.actionKey === WOO_SET_PRICE || c.actionKey === WOO_SET_COMPARE_AT) {
      const wooField = String(c.params?.wooField ?? '')
      if (!isMoney(c.change.to)) return refused(base, 'the target price is not a valid amount')
      if (c.change.field !== writes) return refused(base, 'invalid correction parameters')
      if (c.actionKey === WOO_SET_COMPARE_AT ? wooField !== 'regular_price' : !['regular_price', 'sale_price'].includes(wooField)) return refused(base, 'invalid correction parameters')
      return put(site, t, { [wooField]: c.change.to }, base)
    }

    // SKU
    const to = c.change.to
    if (c.change.field !== 'sku' || typeof to !== 'string' || !to.trim() || to.length > 255 || to !== to.trim()) return refused(base, 'the target SKU is empty, padded or too long')
    return put(site, t, { sku: to }, base)
  },
}
