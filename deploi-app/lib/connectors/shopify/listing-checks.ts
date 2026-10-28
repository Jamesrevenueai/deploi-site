/**
 * Shopify listing checks for agents: product publication, price and SKU. Each compares the store
 * with an explicit merchant instruction (an uploaded reference file or a tag rule). A difference
 * without an instruction is never an error, values are never invented, and anything ambiguous goes
 * to a person instead of becoming a proposed change. Evidence for each rule:
 * docs/platform-research/shopify-workflows.md.
 */
import type { CheckContext, CheckDef, Finding, LookupKeys } from '../../engine/types'
import type { PriceRow, PublicationRow, ReferenceIndex, ReferenceRow, SkuRow } from '../../agents/references'
import { moneyCents } from '../../agents/references'
import type { ShopifyVariantRecord } from './types'

export const PUBLICATION_CHECK = 'shopify.publication'
export const PRICE_CHECK = 'shopify.price'
export const SKU_CHECK = 'shopify.sku'
export const PUBLISH_ACTION = 'shopify.product.publish'
export const UNPUBLISH_ACTION = 'shopify.product.unpublish'
export const SET_PRICE_ACTION = 'shopify.variant.set_price'
export const SET_COMPARE_AT_ACTION = 'shopify.variant.set_compare_at_price'
export const SET_SKU_ACTION = 'shopify.variant.set_sku'

const variantLabel = (r: ShopifyVariantRecord) => `${r.productTitle}${r.variantTitle && r.variantTitle !== 'Default Title' ? ` / ${r.variantTitle}` : ''}${r.sku ? ` (SKU ${r.sku})` : ''}`
const lower = (s: string) => s.trim().toLowerCase()
const base = (r: ShopifyVariantRecord) => ({ productId: r.productId, productTitle: r.productTitle, productHandle: r.productHandle, productStatus: r.productStatus, productTags: r.productTags, fetchedAt: r.fetchedAt })

type Hit<T extends ReferenceRow> = { rowNumber: number; row: T; via: string }
function lookup<T extends ReferenceRow>(ref: ReferenceIndex | undefined, keys: { key: string; via: string }[]): Hit<T>[] {
  if (!ref) return []
  const out: Hit<T>[] = []
  for (const k of keys) for (const h of ref.byKey.get(k.key) ?? []) out.push({ rowNumber: h.rowNumber, row: h.row as T, via: k.via })
  return out
}
const refEvidence = (ref: ReferenceIndex, hits: Hit<ReferenceRow>[]) => ({ sourceId: ref.id, name: ref.name, version: ref.version, rows: hits.map(h => h.rowNumber), matchedBy: [...new Set(hits.map(h => h.via))] })
/** bound into the proposal: a new version of the file makes an earlier proposal stale */
const refParam = (ref: ReferenceIndex, hit: Hit<ReferenceRow>) => ({ sourceId: ref.id, version: ref.version, row: hit.rowNumber })

function person(checkKey: string, fingerprint: string, r: ShopifyVariantRecord, resource: { type: string; id: string; label: string }, summary: string, humanAction: string, evidence: Record<string, unknown>, severity: Finding['severity'] = 'medium'): Finding {
  return { checkKey, kind: 'needs_person', fingerprint, resourceType: resource.type, resourceId: resource.id, resourceLabel: resource.label, severity, summary, evidence: { ...base(r), ...evidence }, humanAction }
}

// ------------------------------------------------------------------ publication

export type PublicationConfig = { publicationId: string; publicationName: string; sourceId: string | null; publishTags: string[]; allowUnpublish: boolean }

export const publicationCheck: CheckDef<ShopifyVariantRecord, Finding> = {
  key: PUBLICATION_CHECK,
  platform: 'shopify',
  title: 'Published differently from your instructions',
  description: 'Products whose publication on the sales channel you chose differs from your publication list or tag rule.',
  whyItIsAnError:
    'Unpublished, draft and archived products are often intentional, so Deploi only acts on your explicit instruction for the one sales channel you authorized. Products scheduled to publish later are left alone. Drafts, archived and unlisted products are reported, never published, because changing a product\'s status needs its own decision.',
  kind: 'correctable',
  resourceType: 'variant',
  defaultEnabled: false,
  defaultConfig: {},
  agentOnly: true,
  parseConfig(raw) {
    const r = (raw ?? {}) as Record<string, unknown>
    const publicationId = String(r.publicationId ?? '')
    if (!/^gid:\/\/shopify\/Publication\/\d+$/.test(publicationId)) throw new Error('publicationId must be a Shopify publication id')
    return {
      publicationId, publicationName: String(r.publicationName ?? 'sales channel').slice(0, 120),
      sourceId: typeof r.sourceId === 'string' && r.sourceId ? r.sourceId : null,
      publishTags: [...new Set((Array.isArray(r.publishTags) ? r.publishTags : []).map(t => lower(String(t))).filter(Boolean))],
      allowUnpublish: Boolean(r.allowUnpublish),
    }
  },
  detect(r, raw, ctx: CheckContext): Finding | null {
    const cfg = raw as PublicationConfig
    const pub = cfg.publicationId
    const fp = `${PUBLICATION_CHECK}:${r.productId}:${pub}`
    const product = { type: 'product', id: r.productId, label: r.productTitle }
    // the instruction: a publication-list row (by product id or handle), else a publish tag
    let desired: boolean | null = null
    let source: Record<string, unknown> = {}
    let param: Record<string, unknown> | null = null
    if (cfg.sourceId) {
      const ref = ctx.references?.[cfg.sourceId]
      if (!ref) return null // no usable file: nothing to compare with (the run reports the missing source)
      const hits = lookup<PublicationRow>(ref, [{ key: `product:${r.productId}`, via: 'product_id' }, ...(r.productHandle ? [{ key: `handle:${lower(r.productHandle)}`, via: 'product_handle' }] : [])])
      if (!hits.length) return null
      const values = new Set(hits.map(h => h.row.published))
      if (hits.some(h => h.row.ambiguous) || values.size > 1) {
        return person(PUBLICATION_CHECK, fp, r, product, `Your publication list has conflicting rows for this product (rows ${hits.map(h => h.rowNumber).join(', ')}).`,
          'Keep one row for this product in the publication list and upload it again. Deploi does not pick between conflicting instructions.', { reference: refEvidence(ref, hits), publicationId: pub }, 'low')
      }
      desired = hits[0].row.published
      source = { reference: refEvidence(ref, hits) }
      param = refParam(ref, hits[0])
    } else {
      const tags = r.productTags.map(lower)
      const tag = cfg.publishTags.find(t => tags.includes(t))
      if (!tag) return null // tags only ever say "publish"; no tag is not an instruction to unpublish
      desired = true
      source = { rule: { publishTags: cfg.publishTags, matchedTag: tag } }
      param = { tag }
    }
    const current = r.published[pub] === true
    if (current === desired) return null
    if (r.scheduledOn.includes(pub)) return null // a future-dated publication is an intentional schedule
    const evidence = { ...source, publicationId: pub, publicationName: cfg.publicationName, publishedNow: current, scheduledOn: r.scheduledOn, onlineStoreUrl: r.onlineStoreUrl, desired }
    if (r.productStatus !== 'ACTIVE') {
      return person(PUBLICATION_CHECK, fp, r, product,
        `Your instructions say ${desired ? 'publish' : 'unpublish'} on ${cfg.publicationName}, but the product is ${String(r.productStatus).toLowerCase()}.`,
        `Deploi does not change a product's status. If it should be ${desired ? 'live' : 'hidden'}, change its status in Shopify, or update your instructions.`, evidence, 'low')
    }
    if (!desired && !cfg.allowUnpublish) {
      return person(PUBLICATION_CHECK, fp, r, product, `Your instructions say this should not be on ${cfg.publicationName}, but this agent is not allowed to unpublish.`,
        'Unpublish it yourself in Shopify, or allow this agent to unpublish (that change needs your approval).', evidence, 'low')
    }
    if (desired && r.requiresSellingPlan) {
      return person(PUBLICATION_CHECK, fp, r, product, 'This product can only be sold through a subscription or pre-order plan.',
        'Check that the selling plan app supports this channel, then publish it yourself.', evidence, 'low')
    }
    return {
      checkKey: PUBLICATION_CHECK,
      kind: 'correctable',
      fingerprint: fp,
      resourceType: 'product',
      resourceId: r.productId,
      resourceLabel: r.productTitle,
      severity: desired ? 'medium' : 'high',
      summary: desired ? `Not published on ${cfg.publicationName}, but your instructions say it should be.` : `Published on ${cfg.publicationName}, but your instructions say it should not be.`,
      evidence: { ...base(r), ...evidence },
      correction: {
        actionKey: desired ? PUBLISH_ACTION : UNPUBLISH_ACTION,
        targetType: 'product',
        targetId: r.productId,
        targetLabel: r.productTitle,
        change: { field: `published.${pub}`, from: current, to: desired },
        params: { publicationId: pub, source: param },
        preconditions: [
          { path: 'productStatus', equals: 'ACTIVE', description: 'the product is still active' },
          { path: 'productId', equals: r.productId, description: 'the same product' },
        ],
      },
    }
  },
}

// ------------------------------------------------------------------ price

export type PriceConfig = { sourceId: string; fields: ('price' | 'compareAtPrice')[]; maxChangePct: number | null; skipVariantsOnSale: boolean }

function priceHits(r: ShopifyVariantRecord, ref: ReferenceIndex): Hit<PriceRow>[] {
  return lookup<PriceRow>(ref, [{ key: `variant:${r.variantId}`, via: 'variant_id' }, ...(r.sku ? [{ key: `sku:${lower(r.sku)}`, via: 'sku' }] : [])])
}

export const priceCheck: CheckDef<ShopifyVariantRecord, Finding[]> = {
  key: PRICE_CHECK,
  platform: 'shopify',
  title: 'Price differs from your price list',
  description: 'Variants whose price (or compare-at price) in the store currency differs from your approved price list.',
  whyItIsAnError:
    'The price list is your own statement of what each variant should cost. Deploi compares amounts exactly, only in the store currency, and only for variants the list identifies unambiguously. It never invents a price, never clears a compare-at price, leaves variants on sale alone if you ask, and blocks variants with fixed Markets or B2B prices, because changing the base price would not reach those buyers.',
  kind: 'correctable',
  resourceType: 'variant',
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
    const cfg = raw as PriceConfig
    const ref = ctx.references?.[cfg.sourceId]
    if (!ref || r.isGiftCard || r.productStatus === 'ARCHIVED') return null
    const hits = priceHits(r, ref)
    if (!hits.length) return null
    const fp = (f: string) => `${PRICE_CHECK}:${r.variantId}:${f}`
    const variant = { type: 'variant', id: r.variantId, label: variantLabel(r) }
    const evidence = { variantId: r.variantId, variantTitle: r.variantTitle, sku: r.sku, price: r.price, compareAtPrice: r.compareAtPrice, storeCurrency: ctx.store?.currency ?? null, reference: refEvidence(ref, hits) }
    const block = (summary: string, action: string) => [person(PRICE_CHECK, fp('price'), r, variant, summary, action, evidence, 'low')]

    const amounts = new Set(hits.map(h => `${h.row.price}|${h.row.compareAtPrice ?? ''}|${h.row.currency ?? ''}`))
    if (hits.some(h => h.row.ambiguous) || amounts.size > 1) return block(`Your price list has more than one row for this variant (rows ${hits.map(h => h.rowNumber).join(', ')}).`, 'Keep one row for this variant and upload the price list again. Deploi does not choose between prices.')
    const viaSku = hits.every(h => h.via === 'sku')
    if (viaSku && r.sku) {
      const others = (ctx.store?.variantIdsBySku(r.sku) ?? []).filter(id => id !== r.variantId)
      if (others.length || (r.duplicateSkuCount ?? 0) > 0) return block(`The price list matches this variant by SKU ${r.sku}, but other variants use the same SKU.`, 'Give each variant its own SKU, or identify it by variant_id in the price list.')
    }
    const row = hits[0].row
    const currency = ctx.store?.currency ?? null
    if (!currency) return block('The store currency is unknown, so prices cannot be compared.', 'Reconnect the store so Deploi can read its currency.')
    if (row.currency && row.currency !== currency) return block(`The price list gives ${row.currency} but the store prices in ${currency}.`, 'Deploi only sets prices in the store currency. Convert the row or remove it.')
    const onSale = r.compareAtPrice !== null && r.price !== null && (moneyCents(r.compareAtPrice) ?? 0) > (moneyCents(r.price) ?? 0)
    if (onSale && cfg.skipVariantsOnSale) return null // an intentional sale price is an exception, not an error

    const out: Finding[] = []
    const param = refParam(ref, hits[0])
    const propose = (field: 'price' | 'compareAtPrice', from: string | null, to: string): Finding => ({
      checkKey: PRICE_CHECK,
      kind: 'correctable',
      fingerprint: fp(field),
      resourceType: 'variant',
      resourceId: r.variantId,
      resourceLabel: variantLabel(r),
      severity: 'medium',
      summary: field === 'price' ? `Price is ${from ?? 'not set'} ${currency}; your price list says ${to}.` : `Compare-at price is ${from ?? 'not set'} ${currency}; your price list says ${to}.`,
      evidence: { ...base(r), ...evidence, field, listed: to },
      correction: {
        actionKey: field === 'price' ? SET_PRICE_ACTION : SET_COMPARE_AT_ACTION,
        targetType: 'variant',
        targetId: r.variantId,
        targetLabel: variantLabel(r),
        change: { field, from, to },
        params: { productId: r.productId, currency, source: param },
        preconditions: [
          { path: 'productId', equals: r.productId, description: 'the variant still belongs to the same product' },
          { path: field, equals: from, description: `the ${field === 'price' ? 'price' : 'compare-at price'} has not changed since the proposal` },
        ],
      },
    })
    if (cfg.fields.includes('price') && r.price !== row.price && moneyCents(r.price ?? '') !== moneyCents(row.price)) out.push(propose('price', r.price, row.price))
    if (cfg.fields.includes('compareAtPrice') && row.compareAtPrice !== null && moneyCents(r.compareAtPrice ?? '') !== moneyCents(row.compareAtPrice)) out.push(propose('compareAtPrice', r.compareAtPrice, row.compareAtPrice))
    return out.length ? out : null
  },
}

// ------------------------------------------------------------------ SKU

export type SkuConfig = { sourceId: string; allowOverwrite: boolean }

export const skuCheck: CheckDef<ShopifyVariantRecord, Finding> = {
  key: SKU_CHECK,
  platform: 'shopify',
  title: 'SKU missing or different from your mapping',
  description: 'Variants whose SKU is empty, or differs from your approved SKU mapping, when the mapping identifies exactly one variant.',
  whyItIsAnError:
    'The mapping is your own record of the correct SKU. Deploi matches each row by variant id, barcode, or product handle plus variant title, and only proposes a change when exactly one variant matches and the new SKU is not already in use. It never generates an identifier; anything ambiguous goes to you.',
  kind: 'correctable',
  resourceType: 'variant',
  defaultEnabled: false,
  defaultConfig: {},
  agentOnly: true,
  parseConfig(raw) {
    const r = (raw ?? {}) as Record<string, unknown>
    if (typeof r.sourceId !== 'string' || !r.sourceId) throw new Error('a SKU mapping is required')
    return { sourceId: r.sourceId, allowOverwrite: Boolean(r.allowOverwrite) }
  },
  lookupKeys(r, raw, ctx): LookupKeys {
    const cfg = raw as SkuConfig
    const hits = skuHits(r, ctx.references?.[cfg.sourceId])
    return { skus: [...new Set([...(r.sku ? [r.sku] : []), ...hits.map(h => h.row.sku)])], barcodes: r.barcodes, handles: r.productHandle ? [r.productHandle] : [] }
  },
  detect(r, raw, ctx): Finding | null {
    const cfg = raw as SkuConfig
    const ref = ctx.references?.[cfg.sourceId]
    if (!ref || r.isGiftCard) return null
    const hits = skuHits(r, ref)
    if (!hits.length) return null
    const fp = `${SKU_CHECK}:${r.variantId}`
    const variant = { type: 'variant', id: r.variantId, label: variantLabel(r) }
    const evidence = { variantId: r.variantId, variantTitle: r.variantTitle, sku: r.sku, barcodes: r.barcodes, reference: refEvidence(ref, hits) }
    const block = (summary: string, action: string) => person(SKU_CHECK, fp, r, variant, summary, action, evidence, 'low')

    const targets = new Set(hits.map(h => h.row.sku))
    if (hits.some(h => h.row.ambiguous) || targets.size > 1) return block(`Your SKU mapping matches this variant more than once (rows ${hits.map(h => h.rowNumber).join(', ')}).`, 'Keep one row for this variant and upload the mapping again. Deploi does not choose between SKUs.')
    const hit = hits[0]
    // the row's key must identify exactly this one variant in the store
    const store = ctx.store
    const matched = hit.via === 'variant_id' ? [r.variantId]
      : hit.via === 'barcode' ? (store?.variantIdsByBarcode(hit.row.barcode ?? '') ?? [r.variantId])
      : (store?.variantIdsByHandleTitle(hit.row.handle ?? '', hit.row.variantTitle ?? '') ?? [r.variantId])
    if (matched.length !== 1) return block(`Row ${hit.rowNumber} of your SKU mapping matches ${matched.length} variants by ${hit.via === 'barcode' ? 'barcode' : 'handle and title'}.`, 'Identify the variant by variant_id instead, or make the barcode unique.')
    const target = hit.row.sku
    if (r.sku === target) return null
    if (hit.row.duplicateTarget) return block(`Your SKU mapping gives SKU ${target} to more than one variant.`, 'Each SKU should belong to one variant. Correct the mapping and upload it again.')
    const inUse = (store?.variantIdsBySku(target) ?? []).filter(id => id !== r.variantId)
    if (inUse.length) return block(`SKU ${target} is already used by another variant in the store.`, 'Change or remove the SKU on the other variant first, or correct the mapping. Deploi never creates duplicate SKUs.')
    if (r.sku && !cfg.allowOverwrite) return block(`The SKU is ${r.sku}; your mapping says ${target}. This agent may only fill missing SKUs.`, 'Correct it yourself in Shopify, or allow this agent to correct existing SKUs (that change needs your approval).')
    return {
      checkKey: SKU_CHECK,
      kind: 'correctable',
      fingerprint: fp,
      resourceType: 'variant',
      resourceId: r.variantId,
      resourceLabel: variantLabel(r),
      severity: r.sku ? 'medium' : 'low',
      summary: r.sku ? `SKU is ${r.sku}; your mapping says ${target}.` : `SKU is missing; your mapping says ${target}.`,
      evidence: { ...base(r), ...evidence, mapped: target },
      correction: {
        actionKey: SET_SKU_ACTION,
        targetType: 'variant',
        targetId: r.variantId,
        targetLabel: variantLabel(r),
        change: { field: 'sku', from: r.sku, to: target },
        params: { productId: r.productId, source: refParam(ref, hit) },
        preconditions: [
          { path: 'productId', equals: r.productId, description: 'the variant still belongs to the same product' },
          { path: 'sku', equals: r.sku, description: 'the SKU has not changed since the proposal' },
        ],
      },
    }
  },
}

function skuHits(r: ShopifyVariantRecord, ref: ReferenceIndex | undefined): Hit<SkuRow>[] {
  return lookup<SkuRow>(ref, [
    { key: `variant:${r.variantId}`, via: 'variant_id' },
    ...r.barcodes.map(b => ({ key: `barcode:${b.trim()}`, via: 'barcode' })),
    ...(r.productHandle ? [{ key: `handle:${lower(r.productHandle)}|${lower(r.variantTitle)}`, via: 'handle_option' }] : []),
  ])
}
