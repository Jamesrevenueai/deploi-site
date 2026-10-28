/**
 * Shopify single-platform checks. Both use only Shopify records and the merchant's own rule.
 * Neither guesses a physical stock count. See docs/shopify-workflow.md for the reasoning.
 */
import type { CheckDef, Finding } from '../../engine/types'
import type { ShopifyVariantRecord } from './types'

export const OVERSELL_CHECK = 'shopify.oversell_policy'
export const OVERSOLD_CHECK = 'shopify.oversold_stop_selling'
export const SET_POLICY_ACTION = 'shopify.variant.set_inventory_policy'

export const DEFAULT_EXEMPT_TAGS = ['preorder', 'pre-order', 'backorder', 'made-to-order', 'made to order']

const label = (r: ShopifyVariantRecord) => `${r.productTitle}${r.variantTitle && r.variantTitle !== 'Default Title' ? ` / ${r.variantTitle}` : ''}${r.sku ? ` (SKU ${r.sku})` : ''}`

const levelEvidence = (r: ShopifyVariantRecord) => r.levels.map(l => ({ location: l.locationName, locationId: l.locationId, available: l.available, onHand: l.onHand, committed: l.committed }))

function strList(v: unknown, max: number, field: string): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) throw new Error(`${field} must be a list`)
  const out = v.map(x => String(x).trim()).filter(Boolean)
  if (out.length > max) throw new Error(`${field} allows at most ${max} entries`)
  return [...new Set(out)]
}

export type OversellConfig = { exemptTags: string[]; exemptProductIds: string[]; flagInStockVariants: boolean }

export const oversellPolicyCheck: CheckDef<ShopifyVariantRecord> = {
  key: OVERSELL_CHECK,
  platform: 'shopify',
  title: 'Selling with no stock against your rule',
  description: 'Active products whose inventory is tracked but that are set to "Continue selling when out of stock", when your rule says they should stop selling at zero.',
  whyItIsAnError:
    'Shopify lets a merchant keep selling past zero on purpose (pre-orders, backorders, made-to-order). Deploi only calls it an error after you turn this rule on, and it skips products you tagged or listed as exempt, products sold through selling plans (how pre-order and subscription apps work), gift cards, untracked inventory and products that are not active. What is left contradicts your own stated policy.',
  kind: 'correctable',
  resourceType: 'variant',
  defaultEnabled: false,
  defaultConfig: { exemptTags: DEFAULT_EXEMPT_TAGS, exemptProductIds: [], flagInStockVariants: true },
  parseConfig(raw) {
    const r = (raw ?? {}) as Record<string, unknown>
    return {
      exemptTags: [...new Set(strList(r.exemptTags ?? DEFAULT_EXEMPT_TAGS, 50, 'exemptTags').map(t => t.toLowerCase()))],
      exemptProductIds: strList(r.exemptProductIds, 2000, 'exemptProductIds').filter(id => /^gid:\/\/shopify\/Product\/\d+$/.test(id)),
      flagInStockVariants: r.flagInStockVariants === undefined ? true : Boolean(r.flagInStockVariants),
    }
  },
  detect(r, rawCfg): Finding | null {
    const cfg = rawCfg as OversellConfig
    if (r.productStatus !== 'ACTIVE') return null
    if (r.isGiftCard) return null
    if (!r.tracked) return null
    if (r.inventoryPolicy !== 'CONTINUE') return null
    if ((cfg.exemptProductIds ?? []).includes(r.productId)) return null
    const tags = r.productTags.map(t => t.trim().toLowerCase())
    if ((cfg.exemptTags ?? []).some(t => tags.includes(t))) return null
    if (r.sellingPlanGroupsCount > 0 || r.requiresSellingPlan) return null

    const available = r.totalAvailable
    const noStock = available !== null && available <= 0
    if (!noStock && !cfg.flagInStockVariants) return null
    const oversoldUnits = available !== null && available < 0 ? -available : 0
    return {
      checkKey: OVERSELL_CHECK,
      kind: 'correctable',
      fingerprint: `${OVERSELL_CHECK}:${r.variantId}`,
      resourceType: 'variant',
      resourceId: r.variantId,
      resourceLabel: label(r),
      severity: noStock ? 'high' : 'medium',
      summary: noStock
        ? `Taking orders with ${available} available: "Continue selling when out of stock" is on.`
        : `Will keep taking orders after the last ${available ?? 'unknown number of'} unit${available === 1 ? '' : 's'} sell: "Continue selling when out of stock" is on.`,
      evidence: {
        productId: r.productId, productTitle: r.productTitle, productHandle: r.productHandle, variantTitle: r.variantTitle, sku: r.sku,
        productStatus: r.productStatus, inventoryPolicy: r.inventoryPolicy, tracked: r.tracked, totalAvailable: available, oversoldUnits,
        levels: levelEvidence(r), levelsComplete: r.levelsComplete, sellingPlanGroupsCount: r.sellingPlanGroupsCount, productTags: r.productTags,
        rule: { exemptTags: cfg.exemptTags, exemptProductCount: (cfg.exemptProductIds ?? []).length }, fetchedAt: r.fetchedAt,
      },
      humanAction: oversoldUnits > 0
        ? `Already ${oversoldUnits} unit${oversoldUnits === 1 ? '' : 's'} oversold. Stopping overselling does not change existing orders: decide how to fulfil or cancel them.`
        : undefined,
      correction: {
        actionKey: SET_POLICY_ACTION,
        targetType: 'variant',
        targetId: r.variantId,
        targetLabel: label(r),
        change: { field: 'inventoryPolicy', from: 'CONTINUE', to: 'DENY' },
        params: { productId: r.productId },
        preconditions: [
          { path: 'inventoryPolicy', equals: 'CONTINUE', description: '"Continue selling when out of stock" is still on' },
          { path: 'tracked', equals: true, description: 'inventory is still tracked' },
          { path: 'productStatus', equals: 'ACTIVE', description: 'the product is still active' },
          { path: 'productId', equals: r.productId, description: 'the variant still belongs to the same product' },
        ],
      },
    }
  },
}

export const oversoldCheck: CheckDef<ShopifyVariantRecord> = {
  key: OVERSOLD_CHECK,
  platform: 'shopify',
  title: 'Oversold while set to stop selling',
  description: 'Variants set to stop selling at zero whose available quantity is below zero at one or more locations.',
  whyItIsAnError:
    'The variant is set to stop selling when out of stock, so a negative available quantity cannot be the intended state: more units are committed to orders than are on hand. Deploi does not change stock counts, because only a physical count or a receiving record can say what is really on the shelf; a person has to decide.',
  kind: 'needs_person',
  resourceType: 'variant',
  defaultEnabled: true,
  defaultConfig: {},
  parseConfig: () => ({}),
  detect(r): Finding | null {
    if (!r.tracked || r.inventoryPolicy !== 'DENY') return null
    const negative = r.levels.filter(l => typeof l.available === 'number' && l.available < 0)
    if (!negative.length) return null
    const short = negative.reduce((s, l) => s + -(l.available as number), 0)
    return {
      checkKey: OVERSOLD_CHECK,
      kind: 'needs_person',
      fingerprint: `${OVERSOLD_CHECK}:${r.variantId}`,
      resourceType: 'variant',
      resourceId: r.variantId,
      resourceLabel: label(r),
      severity: 'high',
      summary: `Oversold by ${short} at ${negative.map(l => l.locationName).join(', ')} even though it is set to stop selling at zero.`,
      evidence: {
        productId: r.productId, productTitle: r.productTitle, variantTitle: r.variantTitle, sku: r.sku, productStatus: r.productStatus,
        inventoryPolicy: r.inventoryPolicy, tracked: r.tracked, totalAvailable: r.totalAvailable, shortUnits: short, levels: levelEvidence(r), levelsComplete: r.levelsComplete, fetchedAt: r.fetchedAt,
      },
      humanAction: 'Count the stock at the listed locations, receive any incoming inventory, or contact the customers whose orders cannot be filled. Deploi does not adjust stock counts.',
    }
  },
}
