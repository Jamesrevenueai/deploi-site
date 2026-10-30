import '../merchant/env'
import { describe, it, expect } from 'vitest'
import { handleSynthetic } from '../../lib/connectors/shopify/synthetic'
import { normalizeVariant, type GqlVariant } from '../../lib/connectors/shopify/normalize'
import { northwindState, NORTHWIND_IDS, NORTHWIND_REFERENCES, ONLINE_STORE } from '../../lib/connectors/shopify/demo-store'
import { publicationCheck, priceCheck, skuCheck, PUBLISH_ACTION, UNPUBLISH_ACTION, SET_PRICE_ACTION, SET_SKU_ACTION } from '../../lib/connectors/shopify/listing-checks'
import { parseReference, indexReference, type ReferenceKind } from '../../lib/agents/references'
import { buildStoreContext } from '../../lib/engine/plan'
import type { CheckContext, Finding } from '../../lib/engine/types'
import type { ShopifyVariantRecord } from '../../lib/connectors/shopify/types'

const { V, P } = NORTHWIND_IDS
const NOW = new Date('2026-10-28T12:00:00Z')

function records(state = northwindState()): ShopifyVariantRecord[] {
  const r = handleSynthetic(state, { operationName: 'DeploiVariants', variables: { first: 250 } }, NOW)
  return (r.json as { data: { productVariants: { nodes: GqlVariant[] } } }).data.productVariants.nodes.map(n => normalizeVariant(n, NOW.toISOString(), NOW))
}
const ref = (kind: ReferenceKind, csv: string, id = `ref-${kind}`, version = 1) => indexReference({ id, name: kind, kind, version }, parseReference(kind, csv))

function run(check: typeof publicationCheck | typeof priceCheck | typeof skuCheck, cfg: Record<string, unknown>, ctx: Partial<CheckContext>, recs = records()) {
  const store = buildStoreContext(recs, 'USD', true)
  const out = new Map<string, Finding>()
  const parsed = check.parseConfig(cfg)
  for (const r of recs) {
    const f = (check.detect as (r: ShopifyVariantRecord, c: Record<string, unknown>, x: CheckContext) => Finding | Finding[] | null)(r, parsed, { ruleVersion: 1, store, ...ctx })
    for (const x of Array.isArray(f) ? f : f ? [f] : []) if (!out.has(x.fingerprint)) out.set(x.fingerprint, x)
  }
  return [...out.values()]
}
const summary = (fs: Finding[]) => Object.fromEntries(fs.map(f => [`${f.resourceId}${f.correction?.change.field === 'compareAtPrice' ? ':cap' : ''}`, f.kind === 'correctable' ? f.correction!.actionKey : 'person']))

describe('publication workflow', () => {
  const pubRef = ref('publication_list', NORTHWIND_REFERENCES.publication)
  const cfg = { publicationId: ONLINE_STORE, publicationName: 'Online Store', sourceId: pubRef.id, allowUnpublish: true }

  it('acts only on explicit instructions: publish, unpublish, and people for drafts and conflicts; schedules left alone', () => {
    const fs = run(publicationCheck, cfg, { references: { [pubRef.id]: pubRef } })
    expect(summary(fs)).toEqual({
      [P(1003)]: PUBLISH_ACTION,      // walnut board: list says yes, not on Online Store
      [P(1012)]: UNPUBLISH_ACTION,    // olive spoon: list says no
      [P(1008)]: 'person',            // draft: status is never changed
      [P(1009)]: 'person',            // napkins: conflicting rows
    })
    const publish = fs.find(f => f.resourceId === P(1003))!
    expect(publish.correction).toMatchObject({ targetType: 'product', change: { field: `published.${ONLINE_STORE}`, from: false, to: true }, params: { publicationId: ONLINE_STORE, source: { sourceId: pubRef.id, version: 1 } } })
    expect(publish.evidence).toMatchObject({ productStatus: 'ACTIVE', publishedNow: false, reference: { name: 'publication_list', version: 1 } })
  })

  it('never unpublishes without permission: it reports instead', () => {
    const fs = run(publicationCheck, { ...cfg, allowUnpublish: false }, { references: { [pubRef.id]: pubRef } })
    expect(summary(fs)[P(1012)]).toBe('person')
    expect(fs.some(f => f.correction?.actionKey === UNPUBLISH_ACTION)).toBe(false)
  })

  it('a tag rule only ever publishes; untagged unpublished products are not errors', () => {
    const state = northwindState()
    state.products.find(p => p.id === P(1003))!.tags = ['launch']
    const fs = run(publicationCheck, { publicationId: ONLINE_STORE, publicationName: 'Online Store', sourceId: null, publishTags: ['Launch'] }, {}, records(state))
    expect(summary(fs)).toEqual({ [P(1003)]: PUBLISH_ACTION })
  })

  it('a missing file means nothing to compare with, never a guess', () => {
    expect(run(publicationCheck, cfg, { references: {} })).toEqual([])
  })
})

describe('price workflow', () => {
  const priceRef = ref('price_list', NORTHWIND_REFERENCES.price)
  const cfg = { sourceId: priceRef.id, fields: ['price'], maxChangePct: 20, skipVariantsOnSale: true }

  it('proposes confirmed mismatches in the store currency and routes ambiguity and currency mismatches to a person', () => {
    const fs = run(priceCheck, cfg, { references: { [priceRef.id]: priceRef } })
    expect(summary(fs)).toEqual({
      [V(2001)]: SET_PRICE_ACTION,  // 79.00 -> 89.00
      [V(2004)]: SET_PRICE_ACTION,  // 45.00 -> 65.00 (over the limit: qualification decides, not detection)
      [V(2003)]: SET_PRICE_ACTION,  // fixed price-list price: blocked by the connector before writing
      [V(2012)]: 'person',          // EUR row in a USD store
      [V(2013)]: 'person',          // two different rows
    })
    expect(fs.find(f => f.resourceId === V(2001))!.correction!.change).toEqual({ field: 'price', from: '79.00', to: '89.00' })
  })

  it('never touches variants on sale unless told to, and never clears a compare-at price', () => {
    const fs = run(priceCheck, { ...cfg, skipVariantsOnSale: false, fields: ['price', 'compareAtPrice'] }, { references: { [priceRef.id]: priceRef } })
    expect(summary(fs)[V(2015)]).toBe(SET_PRICE_ACTION)
    expect(fs.filter(f => f.correction?.change.field === 'compareAtPrice')).toEqual([])
  })

  it('blocks a SKU match when the SKU is shared, and when the store currency is unknown', () => {
    const state = northwindState()
    state.products.find(p => p.id === P(1012))!.variants[0].sku = 'NW-LTB-OAT'
    const fs = run(priceCheck, cfg, { references: { [priceRef.id]: priceRef } }, records(state))
    expect(summary(fs)[V(2001)]).toBe('person')
    const store = buildStoreContext(records(), null, true)
    const f = priceCheck.detect(records().find(r => r.variantId === V(2001))!, priceCheck.parseConfig(cfg), { ruleVersion: 1, store, references: { [priceRef.id]: priceRef } })
    expect(f![0].kind).toBe('needs_person')
  })

  it('a new version of the price list changes the proposal (old approvals become stale)', () => {
    const v2 = ref('price_list', NORTHWIND_REFERENCES.price, priceRef.id, 2)
    const a = run(priceCheck, cfg, { references: { [priceRef.id]: priceRef } }).find(f => f.resourceId === V(2001))!
    const b = run(priceCheck, cfg, { references: { [priceRef.id]: v2 } }).find(f => f.resourceId === V(2001))!
    expect(a.correction!.params).not.toEqual(b.correction!.params)
  })
})

describe('SKU workflow', () => {
  const skuRef = ref('sku_mapping', NORTHWIND_REFERENCES.sku)
  const cfg = { sourceId: skuRef.id, allowOverwrite: false }

  it('fills only unambiguous matches and blocks shared barcodes, SKUs in use and overwrites', () => {
    const fs = run(skuCheck, cfg, { references: { [skuRef.id]: skuRef } })
    expect(summary(fs)).toEqual({
      [V(2016)]: SET_SKU_ACTION, // coasters: unique barcode, empty SKU
      [V(2017)]: 'person',       // apron: NW-OWS-01 already used by the olive spoon
      [V(2018)]: 'person',       // beeswax: barcode shared by two variants
      [V(2019)]: 'person',
      [V(2008)]: 'person',       // engraved mug: different SKU, overwrite not allowed
    })
    expect(fs.find(f => f.resourceId === V(2016))!.correction!.change).toEqual({ field: 'sku', from: null, to: 'NW-WCO-01' })
  })

  it('corrects an existing SKU only when overwriting is authorized', () => {
    const fs = run(skuCheck, { ...cfg, allowOverwrite: true }, { references: { [skuRef.id]: skuRef } })
    expect(fs.find(f => f.resourceId === V(2008))!.correction!.change).toEqual({ field: 'sku', from: 'NW-CEM-01', to: 'NW-CEM-02' })
  })

  it('blocks a mapping that gives one SKU to two variants, and duplicate rows for one variant', () => {
    const dup = ref('sku_mapping', 'variant_id,sku\n2016,NW-X-1\n2017,NW-X-1\n2018,NW-A\n2018,NW-B\n')
    const fs = run(skuCheck, { sourceId: dup.id, allowOverwrite: false }, { references: { [dup.id]: dup } })
    expect(summary(fs)).toEqual({ [V(2016)]: 'person', [V(2017)]: 'person', [V(2018)]: 'person' })
  })

  it('asks for store-wide lookups of the target SKU, barcodes and handle on targeted reads', () => {
    const r = records().find(x => x.variantId === V(2016))!
    expect(skuCheck.lookupKeys!(r, skuCheck.parseConfig(cfg), { ruleVersion: 1, references: { [skuRef.id]: skuRef } })).toEqual({ skus: ['NW-WCO-01'], barcodes: ['0890000000160'], handles: ['walnut-coasters'] })
  })
})
