/**
 * Synthetic store contents for demos and tests. Every product, SKU and name is invented.
 * The catalogue is built to cover each case the checks must get right (see the expected
 * outcomes in tests/shopify/detection.test.ts).
 */
import type { SynthProduct, SynthState, SynthVariant } from './synthetic'

const P = (n: number) => `gid://shopify/Product/${n}`
const V = (n: number) => `gid://shopify/ProductVariant/${n}`
const I = (n: number) => `gid://shopify/InventoryItem/${n}`
const WAREHOUSE = 'gid://shopify/Location/101'
const SHOP = 'gid://shopify/Location/102'

function variant(n: number, title: string, sku: string | null, policy: 'CONTINUE' | 'DENY', tracked: boolean, stock: [number, number] | null, extra: Partial<SynthVariant> = {}): SynthVariant {
  const levels = stock ? [
    { locationId: WAREHOUSE, available: stock[0], onHand: Math.max(stock[0], 0) + (stock[0] < 0 ? 0 : 0), committed: stock[0] < 0 ? -stock[0] : 0 },
    { locationId: SHOP, available: stock[1], onHand: Math.max(stock[1], 0), committed: stock[1] < 0 ? -stock[1] : 0 },
  ] : []
  return { id: V(n), title, sku, inventoryPolicy: policy, sellingPlanGroupsCount: 0, inventoryItemId: I(n), tracked, levels, ...extra }
}

function product(n: number, title: string, opts: Partial<SynthProduct>, variants: SynthVariant[]): SynthProduct {
  return { id: P(n), title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''), status: 'ACTIVE', tags: [], isGiftCard: false, requiresSellingPlan: false, sellingPlanGroupsCount: 0, updatedAt: '2026-10-20T15:00:00Z', variants, ...opts }
}

export const NORTHWIND_DOMAIN = 'northwind-goods-demo.myshopify.com'
export const HARBOR_DOMAIN = 'harbor-supply-demo.myshopify.com'

export function northwindState(): SynthState {
  return {
    shop: { name: 'Northwind Goods (synthetic)', myshopifyDomain: NORTHWIND_DOMAIN, ianaTimezone: 'America/Chicago', currencyCode: 'USD' },
    locations: [{ id: WAREHOUSE, name: 'Warehouse' }, { id: SHOP, name: 'Retail shop' }],
    products: [
      product(1001, 'Linen Throw Blanket', { tags: ['home'] }, [
        variant(2001, 'Oat', 'NW-LTB-OAT', 'CONTINUE', true, [0, 0]),
        variant(2002, 'Charcoal', 'NW-LTB-CHR', 'DENY', true, [4, 0]),
      ]),
      product(1002, 'Ceramic Pour-Over Set', {}, [variant(2003, 'Default Title', 'NW-CPO-01', 'CONTINUE', true, [-2, 0])]),
      product(1003, 'Walnut Serving Board', {}, [variant(2004, 'Default Title', 'NW-WSB-01', 'CONTINUE', true, [12, 0])]),
      product(1004, 'Holiday Candle', { tags: ['pre-order', 'seasonal'] }, [variant(2005, 'Default Title', 'NW-HC-01', 'CONTINUE', true, [0, 0])]),
      product(1005, 'Coffee Subscription Box', { requiresSellingPlan: true, sellingPlanGroupsCount: 1 }, [variant(2006, 'Default Title', 'NW-CSB-01', 'CONTINUE', true, [0, 0], { sellingPlanGroupsCount: 1 })]),
      product(1006, 'Digital Gift Card', { isGiftCard: true }, [variant(2007, '$25', null, 'CONTINUE', false, null)]),
      product(1007, 'Custom Engraved Mug', {}, [variant(2008, 'Default Title', 'NW-CEM-01', 'CONTINUE', false, null)]),
      product(1008, 'Stoneware Bowl Set', { status: 'DRAFT' }, [variant(2009, 'Default Title', 'NW-SBS-01', 'CONTINUE', true, [0, 0])]),
      product(1009, 'Cotton Napkins (Set of 4)', {}, [variant(2010, 'Default Title', 'NW-CN4-01', 'DENY', true, [-3, 5])]),
      product(1010, 'Glass Storage Jars', {}, [
        variant(2011, 'Small', 'NW-GSJ-S', 'CONTINUE', true, [0, 0]),
        variant(2012, 'Medium', 'NW-GSJ-M', 'DENY', true, [2, 0]),
        variant(2013, 'Large', 'NW-GSJ-L', 'CONTINUE', true, [6, 0]),
      ]),
      product(1011, 'Brass Bottle Opener', { tags: ['Backorder'] }, [variant(2014, 'Default Title', 'NW-BBO-01', 'CONTINUE', true, [0, 0])]),
      product(1012, 'Olive Wood Spoon', {}, [variant(2015, 'Default Title', 'NW-OWS-01', 'DENY', true, [9, 0])]),
    ],
    faults: [],
    writeLog: [],
    subscriptions: [],
  }
}

export function harborState(): SynthState {
  return {
    shop: { name: 'Harbor Supply (synthetic)', myshopifyDomain: HARBOR_DOMAIN, ianaTimezone: 'America/New_York', currencyCode: 'USD' },
    locations: [{ id: WAREHOUSE, name: 'Dock warehouse' }, { id: SHOP, name: 'Showroom' }],
    products: [
      product(3001, 'Rope Basket', {}, [variant(4001, 'Default Title', 'HS-RB-01', 'CONTINUE', true, [0, 0])]),
      product(3002, 'Canvas Tote', {}, [variant(4002, 'Default Title', 'HS-CT-01', 'DENY', true, [3, 1])]),
    ],
    faults: [],
    writeLog: [],
    subscriptions: [],
  }
}

/** Expected findings for the Northwind catalogue: variant id -> [check, severity]. */
export const NORTHWIND_EXPECTED: Record<string, [string, 'high' | 'medium']> = {
  [V(2001)]: ['shopify.oversell_policy', 'high'],
  [V(2003)]: ['shopify.oversell_policy', 'high'],
  [V(2004)]: ['shopify.oversell_policy', 'medium'],
  [V(2011)]: ['shopify.oversell_policy', 'high'],
  [V(2013)]: ['shopify.oversell_policy', 'medium'],
  [V(2010)]: ['shopify.oversold_stop_selling', 'high'],
}
export const NORTHWIND_IDS = { P, V, I, WAREHOUSE, SHOP }
