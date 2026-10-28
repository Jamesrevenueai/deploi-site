import '../merchant/env'
import { describe, it, expect } from 'vitest'
import { handleSynthetic } from '../../lib/connectors/shopify/synthetic'
import { normalizeVariant, type GqlVariant } from '../../lib/connectors/shopify/normalize'
import { northwindState, NORTHWIND_EXPECTED, NORTHWIND_IDS } from '../../lib/connectors/shopify/demo-store'
import { oversellPolicyCheck, oversoldCheck, DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'
import { changeHash } from '../../lib/engine/hash'
import type { ShopifyVariantRecord } from '../../lib/connectors/shopify/types'

const CFG = oversellPolicyCheck.parseConfig({ exemptTags: DEFAULT_EXEMPT_TAGS, exemptProductIds: [], flagInStockVariants: true })

function records(state = northwindState()): ShopifyVariantRecord[] {
  const r = handleSynthetic(state, { operationName: 'DeploiVariants', variables: { first: 250 } })
  const nodes = (r.json as { data: { productVariants: { nodes: GqlVariant[] } } }).data.productVariants.nodes
  return nodes.map(n => normalizeVariant(n, '2026-10-28T12:00:00Z'))
}

function findings(recs: ShopifyVariantRecord[], cfg = CFG) {
  const out: Record<string, [string, string]> = {}
  for (const r of recs) for (const c of [oversellPolicyCheck, oversoldCheck]) {
    const f = c.detect(r, c === oversellPolicyCheck ? cfg : {}, { ruleVersion: 1 })
    if (f) out[f.resourceId] = [f.checkKey, f.severity]
  }
  return out
}

describe('Shopify detection accuracy on the synthetic catalogue', () => {
  it('flags exactly the expected variants with the expected severity (no false positives, no misses)', () => {
    expect(findings(records())).toEqual(NORTHWIND_EXPECTED)
  })

  it('does not flag intentional configurations', () => {
    const got = findings(records())
    const { V } = NORTHWIND_IDS
    expect(got[V(2005)], 'pre-order tag').toBeUndefined()
    expect(got[V(2006)], 'selling plan (pre-order / subscription app)').toBeUndefined()
    expect(got[V(2007)], 'gift card').toBeUndefined()
    expect(got[V(2008)], 'untracked inventory').toBeUndefined()
    expect(got[V(2009)], 'draft product').toBeUndefined()
    expect(got[V(2014)], 'Backorder tag, any case').toBeUndefined()
    expect(got[V(2002)], 'stop selling with stock').toBeUndefined()
  })

  it('the oversell rule produces nothing until the merchant turns it on (default off)', () => {
    expect(oversellPolicyCheck.defaultEnabled).toBe(false)
    expect(oversoldCheck.defaultEnabled).toBe(true)
  })

  it('respects merchant exemptions and the in-stock option', () => {
    const { P, V } = NORTHWIND_IDS
    const cfg = oversellPolicyCheck.parseConfig({ exemptTags: ['pre-order', 'backorder', 'home'], exemptProductIds: [P(1002)], flagInStockVariants: false })
    const got = findings(records(), cfg)
    expect(got[V(2001)], 'tag "home" now exempt').toBeUndefined()
    expect(got[V(2003)], 'product exempted by id').toBeUndefined()
    expect(got[V(2004)], 'in-stock variant not flagged when the option is off').toBeUndefined()
    expect(got[V(2011)]).toEqual(['shopify.oversell_policy', 'high'])
  })

  it('reports oversold units and the human action, and never proposes a stock change', () => {
    const recs = records()
    const pourOver = recs.find(r => r.variantId === NORTHWIND_IDS.V(2003))!
    const f = oversellPolicyCheck.detect(pourOver, CFG, { ruleVersion: 1 })!
    expect(f.evidence.oversoldUnits).toBe(2)
    expect(f.humanAction).toMatch(/oversold/)
    expect(f.correction?.change).toEqual({ field: 'inventoryPolicy', from: 'CONTINUE', to: 'DENY' })
    const napkins = recs.find(r => r.variantId === NORTHWIND_IDS.V(2010))!
    const o = oversoldCheck.detect(napkins, {}, { ruleVersion: 1 })!
    expect(o.kind).toBe('needs_person')
    expect(o.correction).toBeUndefined()
    expect(o.evidence.shortUnits).toBe(3)
  })

  it('the approved change hash ignores stock movement but changes with the rule version or the change itself', () => {
    const r = records().find(x => x.variantId === NORTHWIND_IDS.V(2001))!
    const a = oversellPolicyCheck.detect(r, CFG, { ruleVersion: 1 })!.correction!
    const moved = { ...r, totalAvailable: -5, levels: r.levels.map(l => ({ ...l, available: -5 })) }
    const b = oversellPolicyCheck.detect(moved, CFG, { ruleVersion: 1 })!.correction!
    expect(changeHash('c1', a, 1)).toBe(changeHash('c1', b, 1))
    expect(changeHash('c1', a, 1)).not.toBe(changeHash('c1', a, 2))
    expect(changeHash('c1', a, 1)).not.toBe(changeHash('c2', a, 1))
    expect(changeHash('c1', a, 1)).not.toBe(changeHash('c1', { ...a, change: { ...a.change, to: 'CONTINUE' } }, 1))
  })

  it('rejects invalid rule configuration', () => {
    expect(() => oversellPolicyCheck.parseConfig({ exemptTags: 'preorder' })).toThrow()
    expect(oversellPolicyCheck.parseConfig({ exemptProductIds: ['gid://shopify/Product/1', 'not-an-id'] }).exemptProductIds).toEqual(['gid://shopify/Product/1'])
    expect(oversellPolicyCheck.parseConfig({ exemptTags: ['Pre-Order ', 'pre-order'] }).exemptTags).toEqual(['pre-order'])
  })
})
