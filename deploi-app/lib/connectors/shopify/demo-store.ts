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
const PUB = (n: number) => `gid://shopify/Publication/${n}`
export const ONLINE_STORE = PUB(501)
const PUBLICATIONS = [{ id: ONLINE_STORE, title: 'Online Store' }, { id: PUB(502), title: 'Point of Sale' }, { id: PUB(503), title: 'Shop' }]

function variant(n: number, title: string, sku: string | null, policy: 'CONTINUE' | 'DENY', tracked: boolean, stock: [number, number] | null, extra: Partial<SynthVariant> = {}): SynthVariant {
  const levels = stock ? [
    { locationId: WAREHOUSE, available: stock[0], onHand: Math.max(stock[0], 0) + (stock[0] < 0 ? 0 : 0), committed: stock[0] < 0 ? -stock[0] : 0 },
    { locationId: SHOP, available: stock[1], onHand: Math.max(stock[1], 0), committed: stock[1] < 0 ? -stock[1] : 0 },
  ] : []
  return { id: V(n), title, sku, inventoryPolicy: policy, sellingPlanGroupsCount: 0, inventoryItemId: I(n), tracked, levels, ...extra }
}

function product(n: number, title: string, opts: Partial<SynthProduct>, variants: SynthVariant[]): SynthProduct {
  const status = opts.status ?? 'ACTIVE'
  return { id: P(n), title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''), status, tags: [], isGiftCard: false, requiresSellingPlan: false, sellingPlanGroupsCount: 0, updatedAt: '2026-10-20T15:00:00Z', variants,
    publishedOn: status === 'ACTIVE' ? [ONLINE_STORE, PUB(502)] : [], ...opts }
}

export const NORTHWIND_DOMAIN = 'northwind-goods-demo.myshopify.com'
export const HARBOR_DOMAIN = 'harbor-supply-demo.myshopify.com'

export function northwindState(): SynthState {
  return {
    shop: { name: 'Northwind Goods (synthetic)', myshopifyDomain: NORTHWIND_DOMAIN, ianaTimezone: 'America/Chicago', currencyCode: 'USD' },
    locations: [{ id: WAREHOUSE, name: 'Warehouse' }, { id: SHOP, name: 'Retail shop' }],
    publications: PUBLICATIONS,
    // the pour-over set has a fixed wholesale price: a base-price change would not reach those buyers
    priceListOverrides: [V(2003)],
    products: withPrices([
      product(1001, 'Linen Throw Blanket', { tags: ['home'] }, [
        variant(2001, 'Oat', 'NW-LTB-OAT', 'CONTINUE', true, [0, 0]),
        variant(2002, 'Charcoal', 'NW-LTB-CHR', 'DENY', true, [4, 0]),
      ]),
      product(1002, 'Ceramic Pour-Over Set', {}, [variant(2003, 'Default Title', 'NW-CPO-01', 'CONTINUE', true, [-2, 0])]),
      product(1003, 'Walnut Serving Board', { publishedOn: [PUB(502)] }, [variant(2004, 'Default Title', 'NW-WSB-01', 'CONTINUE', true, [12, 0])]),
      product(1004, 'Holiday Candle', { tags: ['pre-order', 'seasonal'] }, [variant(2005, 'Default Title', 'NW-HC-01', 'CONTINUE', true, [0, 0])]),
      product(1005, 'Coffee Subscription Box', { requiresSellingPlan: true, sellingPlanGroupsCount: 1 }, [variant(2006, 'Default Title', 'NW-CSB-01', 'CONTINUE', true, [0, 0], { sellingPlanGroupsCount: 1 })]),
      product(1006, 'Digital Gift Card', { isGiftCard: true }, [variant(2007, '$25', null, 'CONTINUE', false, null)]),
      product(1007, 'Custom Engraved Mug', { publishedOn: [], scheduled: [{ publicationId: ONLINE_STORE, publishDate: '2099-01-01T00:00:00Z' }] }, [variant(2008, 'Default Title', 'NW-CEM-01', 'CONTINUE', false, null)]),
      product(1008, 'Stoneware Bowl Set', { status: 'DRAFT' }, [variant(2009, 'Default Title', 'NW-SBS-01', 'CONTINUE', true, [0, 0])]),
      product(1009, 'Cotton Napkins (Set of 4)', {}, [variant(2010, 'Default Title', 'NW-CN4-01', 'DENY', true, [-3, 5])]),
      product(1010, 'Glass Storage Jars', {}, [
        variant(2011, 'Small', 'NW-GSJ-S', 'CONTINUE', true, [0, 0]),
        variant(2012, 'Medium', 'NW-GSJ-M', 'DENY', true, [2, 0]),
        variant(2013, 'Large', 'NW-GSJ-L', 'CONTINUE', true, [6, 0]),
      ]),
      product(1011, 'Brass Bottle Opener', { tags: ['Backorder'] }, [variant(2014, 'Default Title', 'NW-BBO-01', 'CONTINUE', true, [0, 0])]),
      product(1012, 'Olive Wood Spoon', {}, [variant(2015, 'Default Title', 'NW-OWS-01', 'DENY', true, [9, 0], { compareAtPrice: '12.00' })]),
      product(1013, 'Walnut Coasters', {}, [variant(2016, 'Default Title', null, 'DENY', true, [20, 0], { barcodes: ['0890000000160'] })]),
      product(1014, 'Linen Apron', {}, [variant(2017, 'Default Title', null, 'DENY', true, [7, 0], { barcodes: ['0890000000177'] })]),
      product(1015, 'Beeswax Wraps', {}, [
        variant(2018, 'Small', null, 'DENY', true, [10, 0], { barcodes: ['0890000000184'] }),
        variant(2019, 'Large', null, 'DENY', true, [10, 0], { barcodes: ['0890000000184'] }),
      ]),
    ]),
    faults: [],
    writeLog: [],
    subscriptions: [],
  }
}

/** Base prices (USD) by variant number; anything not listed costs 20.00. */
const NORTHWIND_PRICES: Record<number, string> = {
  2001: '79.00', 2002: '89.00', 2003: '42.00', 2004: '45.00', 2005: '24.00', 2006: '30.00', 2007: '25.00', 2008: '28.00',
  2009: '64.00', 2010: '16.00', 2011: '12.00', 2012: '15.00', 2013: '19.00', 2014: '18.00', 2015: '9.00', 2016: '22.00', 2017: '34.00', 2018: '11.00', 2019: '16.00',
}
function withPrices(products: SynthProduct[]): SynthProduct[] {
  for (const p of products) for (const v of p.variants) v.price ??= NORTHWIND_PRICES[Number(v.id.split('/').pop())] ?? '20.00'
  return products
}

export function harborState(): SynthState {
  return {
    shop: { name: 'Harbor Supply (synthetic)', myshopifyDomain: HARBOR_DOMAIN, ianaTimezone: 'America/New_York', currencyCode: 'USD' },
    locations: [{ id: WAREHOUSE, name: 'Dock warehouse' }, { id: SHOP, name: 'Showroom' }],
    publications: PUBLICATIONS,
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
export const NORTHWIND_IDS = { P, V, I, WAREHOUSE, SHOP, PUB, ONLINE_STORE }

/**
 * Synthetic reference files for the Northwind demo, each covering the cases its check must get right.
 * Expected outcomes are listed with each file and asserted in tests/shopify/listing-checks.test.ts.
 */
export const NORTHWIND_REFERENCES = {
  /** walnut board: publish (missing from Online Store); olive spoon: unpublish; stoneware (draft): person;
   *  engraved mug (scheduled): skipped; napkins (conflicting rows): person; linen throw: already right */
  publication: `product_handle,product_id,published
walnut-serving-board,,yes
olive-wood-spoon,,no
stoneware-bowl-set,,yes
custom-engraved-mug,,yes
cotton-napkins-set-of-4,,yes
,1009,no
linen-throw-blanket,,yes
`,
  /** oat throw: 79.00 -> 89.00 (12.7%, within limit); walnut board: 45.00 -> 65.00 (44%, over the 20% limit);
   *  pour-over: 42.00 -> 39.50 (fixed wholesale price: blocked at write); bottle opener: unchanged; olive spoon:
   *  on sale, left alone; jars medium: EUR (person); jars large: two different rows (person) */
  price: `sku,variant_id,price,compare_at_price,currency
NW-LTB-OAT,,89.00,,USD
NW-WSB-01,,65.00,,USD
,2003,39.50,,
NW-BBO-01,,18.00,,USD
NW-OWS-01,,12.00,,USD
NW-GSJ-M,,14.00,,EUR
NW-GSJ-L,,21.00,,USD
NW-GSJ-L,,22.00,,USD
`,
  /** coasters: fill by barcode; apron: target already used by the olive spoon (person); beeswax wraps: barcode
   *  shared by two variants (person); engraved mug: different SKU, overwrite not allowed by default (person);
   *  jars small: already right */
  sku: `variant_id,barcode,product_handle,variant_title,sku
,0890000000160,,,NW-WCO-01
,0890000000177,,,NW-OWS-01
,0890000000184,,,NW-BWX-01
2008,,,,NW-CEM-02
,,glass-storage-jars,Small,NW-GSJ-S
`,
}
