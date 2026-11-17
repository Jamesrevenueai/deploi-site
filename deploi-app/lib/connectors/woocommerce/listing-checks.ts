/**
 * WooCommerce listing checks for agents: publication (status publish <-> draft), price and SKU, at parity
 * with the Shopify listing checks and using the same merchant reference files (lib/agents/references.ts).
 * Each compares the store with an explicit merchant instruction. A difference without an instruction is
 * never an error, values are never invented, and anything ambiguous goes to a person.
 *
 * Reference-file keys: the parser stores numeric ids in its canonical id form, so a row's
 * `variant_id` / `product_id` column holds a WooCommerce variation or product id here (a simple product's
 * own id is its "variant" id), `product_handle` is the product slug, `variant_title` is the variation's
 * attribute values joined with " / " ("Default Title" for a simple product), and `barcode` is the
 * WooCommerce GTIN/UPC/EAN/ISBN field (global_unique_id, WooCommerce 9.2+).
 */
import type { CheckContext, CheckDef, Finding, LookupKeys } from '../../engine/types'
import type { PriceRow, PublicationRow, ReferenceIndex, ReferenceRow, SkuRow } from '../../agents/references'
import { moneyCents } from '../../agents/references'
import { WOO_STOREFRONT } from './config'
import type { WooStockRecord } from './checks'

export const WOO_PUBLICATION_CHECK = 'woocommerce.publication'
export const WOO_PRICE_CHECK = 'woocommerce.price'
export const WOO_SKU_CHECK = 'woocommerce.sku'
export const WOO_PUBLISH = 'woocommerce.product.publish'
export const WOO_UNPUBLISH = 'woocommerce.product.unpublish'
export const WOO_SET_PRICE = 'woocommerce.product.set_price'
export const WOO_SET_COMPARE_AT = 'woocommerce.product.set_compare_at_price'
export const WOO_SET_SKU = 'woocommerce.product.set_sku'

/** the reference parser's canonical id forms (numeric ids are stored this way for every platform) */
const refVariant = (n: number) => `variant:gid://shopify/ProductVariant/${n}`
const refProduct = (n: number) => `product:gid://shopify/Product/${n}`
const lower = (s: string) => s.trim().toLowerCase()
const sellableId = (r: WooStockRecord) => r.variationId ?? r.productId
const label = (r: WooStockRecord) => `${r.name}${r.sku ? ` (SKU ${r.sku})` : ''}`
const base = (r: WooStockRecord) => ({ productId: r.productId, variationId: r.variationId, productTitle: r.productTitle ?? r.name, productHandle: r.productHandle ?? null, productStatus: r.wooProductStatus ?? r.status, productTags: r.tags, fetchedAt: r.fetchedAt })

type Hit<T extends ReferenceRow> = { rowNumber: number; row: T; via: string }
function lookup<T extends ReferenceRow>(ref: ReferenceIndex | undefined, keys: { key: string; via: string }[]): Hit<T>[] {
  if (!ref) return []
  const out: Hit<T>[] = []
  for (const k of keys) for (const h of ref.byKey.get(k.key) ?? []) out.push({ rowNumber: h.rowNumber, row: h.row as T, via: k.via })
  return out
}
const refEvidence = (ref: ReferenceIndex, hits: Hit<ReferenceRow>[]) => ({ sourceId: ref.id, name: ref.name, version: ref.version, rows: hits.map(h => h.rowNumber), matchedBy: [...new Set(hits.map(h => h.via))] })
const refParam = (ref: ReferenceIndex, hit: Hit<ReferenceRow>) => ({ sourceId: ref.id, version: ref.version, row: hit.rowNumber })

function person(checkKey: string, fingerprint: string, r: WooStockRecord, resource: { type: string; id: string; label: string }, summary: string, humanAction: string, evidence: Record<string, unknown>, severity: Finding['severity'] = 'medium'): Finding {
  return { checkKey, kind: 'needs_person', fingerprint, resourceType: resource.type, resourceId: resource.id, resourceLabel: resource.label, severity, summary, evidence: { ...base(r), ...evidence }, humanAction }
}

// ------------------------------------------------------------------ publication

export type WooPublicationConfig = { publicationId: string; publicationName: string; sourceId: string | null; publishTags: string[]; allowUnpublish: boolean }

export const wooPublicationCheck: CheckDef<WooStockRecord, Finding> = {
  key: WOO_PUBLICATION_CHECK,
  platform: 'woocommerce',
  title: 'Published differently from your instructions',
  description: 'Products whose status (published or draft) differs from your publication list or tag rule.',
  whyItIsAnError:
    'Drafts are often intentional, so Deploi only acts on your explicit instruction. It only ever moves a product between published and draft. Pending review, private, scheduled and trashed products are reported to you, never changed.',
  kind: 'correctable',
  resourceType: 'woo_stock_object',
  defaultEnabled: false,
  defaultConfig: {},
  agentOnly: true,
  parseConfig(raw) {
    const r = (raw ?? {}) as Record<string, unknown>
    if (r.publicationId !== undefined && r.publicationId !== WOO_STOREFRONT) throw new Error(`publicationId must be ${WOO_STOREFRONT} on WooCommerce`)
    return {
      publicationId: WOO_STOREFRONT, publicationName: String(r.publicationName ?? 'your storefront').slice(0, 120),
      sourceId: typeof r.sourceId === 'string' && r.sourceId ? r.sourceId : null,
      publishTags: [...new Set((Array.isArray(r.publishTags) ? r.publishTags : []).map(t => lower(String(t))).filter(Boolean))],
      allowUnpublish: Boolean(r.allowUnpublish),
    }
  },
  detect(r, raw, ctx: CheckContext): Finding | null {
    if (r.variationId !== null) return null // publication belongs to the product
    const cfg = raw as WooPublicationConfig
    const fp = `${WOO_PUBLICATION_CHECK}:${r.productId}`
    const product = { type: 'woo_stock_object', id: r.resourceId, label: r.name }
    let desired: boolean
    let source: Record<string, unknown>
    let param: Record<string, unknown>
    if (cfg.sourceId) {
      const ref = ctx.references?.[cfg.sourceId]
      if (!ref) return null
      const hits = lookup<PublicationRow>(ref, [{ key: refProduct(r.productId), via: 'product_id' }, ...(r.productHandle ? [{ key: `handle:${lower(r.productHandle)}`, via: 'product_handle' }] : [])])
      if (!hits.length) return null
      if (hits.some(h => h.row.ambiguous) || new Set(hits.map(h => h.row.published)).size > 1) {
        return person(WOO_PUBLICATION_CHECK, fp, r, product, `Your publication list has conflicting rows for this product (rows ${hits.map(h => h.rowNumber).join(', ')}).`,
          'Keep one row for this product in the publication list and upload it again. Deploi does not pick between conflicting instructions.', { reference: refEvidence(ref, hits) }, 'low')
      }
      desired = hits[0].row.published
      source = { reference: refEvidence(ref, hits) }
      param = refParam(ref, hits[0])
    } else {
      const tag = cfg.publishTags.find(t => r.tags.map(lower).includes(t))
      if (!tag) return null // a missing tag is not an instruction to unpublish
      desired = true
      source = { rule: { publishTags: cfg.publishTags, matchedTag: tag } }
      param = { tag }
    }
    const status = r.wooProductStatus ?? r.status
    const current = status === 'publish'
    if (current === desired) return null
    const evidence = { ...source, publicationId: WOO_STOREFRONT, publicationName: cfg.publicationName, wooStatus: status, desired }
    if (status !== 'publish' && status !== 'draft') {
      return person(WOO_PUBLICATION_CHECK, fp, r, product,
        `Your instructions say ${desired ? 'publish' : 'unpublish'} this product, but it is ${status === 'future' ? 'scheduled' : status === 'pending' ? 'pending review' : status}.`,
        'Deploi only moves products between published and draft. Change it yourself in WooCommerce, or update your instructions.', evidence, 'low')
    }
    if (!desired && !cfg.allowUnpublish) {
      return person(WOO_PUBLICATION_CHECK, fp, r, product, 'Your instructions say this should not be published, but this agent is not allowed to unpublish.',
        'Move it to draft yourself in WooCommerce, or allow this agent to unpublish (that change needs your approval).', evidence, 'low')
    }
    return {
      checkKey: WOO_PUBLICATION_CHECK, kind: 'correctable', fingerprint: fp,
      resourceType: 'woo_stock_object', resourceId: r.resourceId, resourceLabel: r.name, severity: desired ? 'medium' : 'high',
      summary: desired ? 'A draft, but your instructions say it should be published.' : 'Published, but your instructions say it should not be.',
      evidence: { ...base(r), ...evidence },
      correction: {
        actionKey: desired ? WOO_PUBLISH : WOO_UNPUBLISH, targetType: 'woo_stock_object', targetId: r.resourceId, targetLabel: r.name,
        change: { field: `published.${WOO_STOREFRONT}`, from: current, to: desired },
        params: { publicationId: WOO_STOREFRONT, source: param },
        preconditions: [
          { path: 'wooProductStatus', equals: desired ? 'draft' : 'publish', description: desired ? 'the product is still a draft' : 'the product is still published' },
          { path: 'productId', equals: r.productId, description: 'the same product' },
        ],
      },
    }
  },
}

// ------------------------------------------------------------------ price

export type WooPriceConfig = { sourceId: string; fields: ('price' | 'compareAtPrice')[]; maxChangePct: number | null; skipVariantsOnSale: boolean }

const priceHits = (r: WooStockRecord, ref: ReferenceIndex) =>
  lookup<PriceRow>(ref, [{ key: refVariant(sellableId(r)), via: 'variant_id' }, ...(r.sku ? [{ key: `sku:${lower(r.sku)}`, via: 'sku' }] : [])])

const comparable = (v: string | null | undefined) => v === null || v === undefined || moneyCents(v) !== null

export const wooPriceCheck: CheckDef<WooStockRecord, Finding[]> = {
  key: WOO_PRICE_CHECK,
  platform: 'woocommerce',
  title: 'Price differs from your price list',
  description: 'Products and variations whose price in the store currency differs from your approved price list.',
  whyItIsAnError:
    'The price list is your own statement of what each item should cost. Deploi compares amounts exactly, only in the store currency, and only for items the list identifies unambiguously. It writes one price field at a time: the regular price, or the sale price while a sale is running. It never invents a price, never starts or ends a sale, and leaves items on sale alone if you ask.',
  kind: 'correctable',
  resourceType: 'woo_stock_object',
  defaultEnabled: false,
  defaultConfig: {},
  agentOnly: true,
  parseConfig(raw) {
    const r = (raw ?? {}) as Record<string, unknown>
    if (typeof r.sourceId !== 'string' || !r.sourceId) throw new Error('a price list is required')
    const fields = (Array.isArray(r.fields) && r.fields.length ? r.fields : ['price']).filter((f): f is 'price' | 'compareAtPrice' => f === 'price' || f === 'compareAtPrice')
    return { sourceId: r.sourceId, fields: fields.length ? fields : ['price'], maxChangePct: r.maxChangePct === null ? null : typeof r.maxChangePct === 'number' ? r.maxChangePct : 20, skipVariantsOnSale: r.skipVariantsOnSale === undefined ? true : Boolean(r.skipVariantsOnSale) }
  },
  lookupKeys(r): LookupKeys { return { skus: r.sku ? [r.sku] : [], barcodes: [], handles: [] } },
  detect(r, raw, ctx): Finding[] | null {
    const cfg = raw as WooPriceConfig
    const ref = ctx.references?.[cfg.sourceId]
    // a variable or grouped parent has no price of its own; trashed items are left alone
    if (!ref || r.type === 'variable' || r.type === 'grouped' || r.status === 'trash') return null
    const hits = priceHits(r, ref)
    if (!hits.length) return null
    const fp = (f: string) => `${WOO_PRICE_CHECK}:${r.resourceId}:${f}`
    const item = { type: 'woo_stock_object', id: r.resourceId, label: label(r) }
    const evidence = { sku: r.sku, regularPrice: r.regularPrice ?? null, salePrice: r.salePrice ?? null, onSale: r.onSale ?? false, storeCurrency: ctx.store?.currency ?? null, reference: refEvidence(ref, hits) }
    const block = (summary: string, action: string) => [person(WOO_PRICE_CHECK, fp('price'), r, item, summary, action, evidence, 'low')]

    const amounts = new Set(hits.map(h => `${h.row.price}|${h.row.compareAtPrice ?? ''}|${h.row.currency ?? ''}`))
    if (hits.some(h => h.row.ambiguous) || amounts.size > 1) return block(`Your price list has more than one row for this item (rows ${hits.map(h => h.rowNumber).join(', ')}).`, 'Keep one row for this item and upload the price list again. Deploi does not choose between prices.')
    if (hits.every(h => h.via === 'sku') && r.sku) {
      const others = (ctx.store?.variantIdsBySku(r.sku) ?? []).filter(id => id !== r.resourceId)
      if (others.length) return block(`The price list matches this item by SKU ${r.sku}, but other items use the same SKU.`, 'Give each item its own SKU, or identify it by variant_id in the price list.')
    }
    const row = hits[0].row
    const currency = ctx.store?.currency ?? null
    if (!currency) return block('The store currency is unknown, so prices cannot be compared.', 'Reconnect the store so Deploi can read its currency.')
    if (row.currency && row.currency !== currency) return block(`The price list gives ${row.currency} but the store prices in ${currency}.`, 'Deploi only sets prices in the store currency. Convert the row or remove it.')
    if (!comparable(r.regularPrice) || !comparable(r.salePrice)) return block('The store shows prices with more than two decimals, so they cannot be compared exactly.', 'Check the price in WooCommerce yourself.')
    if (r.saleScheduled) return block('A sale price is set but not running (scheduled or ended), so it is unclear which price your list refers to.', 'Check the sale dates in WooCommerce, then run the agent again.')
    const onSale = r.onSale === true
    if (onSale && cfg.skipVariantsOnSale) return null // an intentional sale is an exception, not an error

    const out: Finding[] = []
    const param = refParam(ref, hits[0])
    const propose = (field: 'price' | 'compareAtPrice', wooField: 'regular_price' | 'sale_price', from: string | null, to: string): Finding => ({
      checkKey: WOO_PRICE_CHECK, kind: 'correctable', fingerprint: fp(field),
      resourceType: 'woo_stock_object', resourceId: r.resourceId, resourceLabel: label(r), severity: 'medium',
      summary: field === 'price' ? `Price is ${from ?? 'not set'} ${currency}; your price list says ${to}.` : `Regular (struck-through) price is ${from ?? 'not set'} ${currency}; your price list says ${to}.`,
      evidence: { ...base(r), ...evidence, field, wooField, listed: to },
      correction: {
        actionKey: field === 'price' ? WOO_SET_PRICE : WOO_SET_COMPARE_AT, targetType: 'woo_stock_object', targetId: r.resourceId, targetLabel: label(r),
        change: { field, from, to },
        params: { wooField, currency, source: param },
        preconditions: [
          { path: 'productId', equals: r.productId, description: 'the item still belongs to the same product' },
          { path: 'onSale', equals: onSale, description: onSale ? 'the sale is still running' : 'the item is still not on sale' },
          { path: field, equals: from, description: 'the price has not changed since the proposal' },
        ],
      },
    })
    const cents = (v: string | null | undefined) => (v ? moneyCents(v) : null)
    if (cfg.fields.includes('price') && cents(r.price) !== moneyCents(row.price)) out.push(propose('price', onSale ? 'sale_price' : 'regular_price', r.price ?? null, row.price))
    if (cfg.fields.includes('compareAtPrice') && row.compareAtPrice !== null && cents(r.compareAtPrice) !== moneyCents(row.compareAtPrice)) {
      if (!onSale) out.push(person(WOO_PRICE_CHECK, fp('compareAtPrice'), r, item, `Your price list gives a compare-at price of ${row.compareAtPrice}, which on WooCommerce means starting a sale.`,
        'Starting a sale changes two prices and needs its own decision: set the sale in WooCommerce yourself.', evidence, 'low'))
      else out.push(propose('compareAtPrice', 'regular_price', r.compareAtPrice ?? null, row.compareAtPrice))
    }
    return out.length ? out : null
  },
}

// ------------------------------------------------------------------ SKU

export type WooSkuConfig = { sourceId: string; allowOverwrite: boolean }

function skuHits(r: WooStockRecord, ref: ReferenceIndex | undefined): Hit<SkuRow>[] {
  return lookup<SkuRow>(ref, [
    { key: refVariant(sellableId(r)), via: 'variant_id' },
    ...(r.barcodes ?? []).map(b => ({ key: `barcode:${b.trim()}`, via: 'barcode' })),
    ...(r.productHandle && r.variantTitle ? [{ key: `handle:${lower(r.productHandle)}|${lower(r.variantTitle)}`, via: 'handle_option' }] : []),
  ])
}

export const wooSkuCheck: CheckDef<WooStockRecord, Finding> = {
  key: WOO_SKU_CHECK,
  platform: 'woocommerce',
  title: 'SKU missing or different from your mapping',
  description: 'Products and variations whose SKU is empty, or differs from your approved SKU mapping, when the mapping identifies exactly one item.',
  whyItIsAnError:
    'The mapping is your own record of the correct SKU. Deploi matches each row by id, GTIN, or product slug plus variation, and only proposes a change when exactly one item matches and the new SKU is not already in use. WooCommerce also refuses duplicate SKUs itself. Deploi never generates an identifier; anything ambiguous goes to you.',
  kind: 'correctable',
  resourceType: 'woo_stock_object',
  defaultEnabled: false,
  defaultConfig: {},
  agentOnly: true,
  parseConfig(raw) {
    const r = (raw ?? {}) as Record<string, unknown>
    if (typeof r.sourceId !== 'string' || !r.sourceId) throw new Error('a SKU mapping is required')
    return { sourceId: r.sourceId, allowOverwrite: Boolean(r.allowOverwrite) }
  },
  lookupKeys(r, raw, ctx): LookupKeys {
    const hits = skuHits(r, ctx.references?.[(raw as WooSkuConfig).sourceId])
    return { skus: [...new Set([...(r.sku ? [r.sku] : []), ...hits.map(h => h.row.sku)])], barcodes: r.barcodes ?? [], handles: r.productHandle ? [r.productHandle] : [] }
  },
  detect(r, raw, ctx): Finding | null {
    const cfg = raw as WooSkuConfig
    const ref = ctx.references?.[cfg.sourceId]
    if (!ref || r.status === 'trash') return null
    const hits = skuHits(r, ref)
    if (!hits.length) return null
    const fp = `${WOO_SKU_CHECK}:${r.resourceId}`
    const item = { type: 'woo_stock_object', id: r.resourceId, label: label(r) }
    const evidence = { sku: r.sku, barcodes: r.barcodes ?? [], variantTitle: r.variantTitle ?? null, reference: refEvidence(ref, hits) }
    const block = (summary: string, action: string) => person(WOO_SKU_CHECK, fp, r, item, summary, action, evidence, 'low')
    if (hits.some(h => h.row.ambiguous) || new Set(hits.map(h => h.row.sku)).size > 1) return block(`Your SKU mapping matches this item more than once (rows ${hits.map(h => h.rowNumber).join(', ')}).`, 'Keep one row for this item and upload the mapping again. Deploi does not choose between SKUs.')
    const hit = hits[0]
    const store = ctx.store
    const matched = hit.via === 'variant_id' ? [r.resourceId]
      : hit.via === 'barcode' ? (store?.variantIdsByBarcode(hit.row.barcode ?? '') ?? [r.resourceId])
      : (store?.variantIdsByHandleTitle(hit.row.handle ?? '', hit.row.variantTitle ?? '') ?? [r.resourceId])
    if (matched.length !== 1) return block(`Row ${hit.rowNumber} of your SKU mapping matches ${matched.length} items by ${hit.via === 'barcode' ? 'GTIN' : 'slug and variation'}.`, 'Identify the item by variant_id instead, or make the GTIN unique.')
    const target = hit.row.sku
    if (r.sku === target) return null
    if (hit.row.duplicateTarget) return block(`Your SKU mapping gives SKU ${target} to more than one item.`, 'Each SKU should belong to one item. Correct the mapping and upload it again.')
    const inUse = (store?.variantIdsBySku(target) ?? []).filter(id => id !== r.resourceId)
    if (inUse.length) return block(`SKU ${target} is already used by another item in the store.`, 'Change or remove the SKU on the other item first, or correct the mapping. Deploi never creates duplicate SKUs.')
    if (r.sku && !cfg.allowOverwrite) return block(`The SKU is ${r.sku}; your mapping says ${target}. This agent may only fill missing SKUs.`, 'Correct it yourself in WooCommerce, or allow this agent to correct existing SKUs (that change needs your approval).')
    return {
      checkKey: WOO_SKU_CHECK, kind: 'correctable', fingerprint: fp,
      resourceType: 'woo_stock_object', resourceId: r.resourceId, resourceLabel: label(r), severity: r.sku ? 'medium' : 'low',
      summary: r.sku ? `SKU is ${r.sku}; your mapping says ${target}.` : `SKU is missing; your mapping says ${target}.`,
      evidence: { ...base(r), ...evidence, mapped: target },
      correction: {
        actionKey: WOO_SET_SKU, targetType: 'woo_stock_object', targetId: r.resourceId, targetLabel: label(r),
        change: { field: 'sku', from: r.sku, to: target },
        params: { source: refParam(ref, hit) },
        preconditions: [
          { path: 'productId', equals: r.productId, description: 'the item still belongs to the same product' },
          { path: 'sku', equals: r.sku, description: 'the SKU has not changed since the proposal' },
        ],
      },
    }
  },
}
