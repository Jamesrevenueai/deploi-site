/**
 * A synthetic WooCommerce catalogue for tests and demos (all names invented). It covers every check:
 * backorders at zero (simple product and a variation with its own stock), a pre-order exemption, an
 * oversold item, low stock, a variable product whose variations inherit stock, prices that differ from a
 * price list, a missing SKU, a draft to publish, and a scheduled product that must never be touched.
 */
import type { WooSynthState, SynthWooProduct } from './synthetic'

export const WOO_DEMO_SITE = 'https://northwind-woo.example'

const p = (o: Partial<SynthWooProduct> & Pick<SynthWooProduct, 'id' | 'name' | 'slug'>): SynthWooProduct => ({
  type: 'simple', status: 'publish', sku: '', regular_price: '10.00', sale_price: '', manage_stock: true, stock_quantity: 10, backorders: 'no', tags: [], ...o,
})

export function wooDemoState(opts: { siteUrl?: string; keys?: WooSynthState['keys'] } = {}): WooSynthState {
  return {
    kind: 'woocommerce',
    site: { name: 'Northwind Woo (synthetic)', url: opts.siteUrl ?? WOO_DEMO_SITE, timezone: 'America/New_York', currency: 'USD', wcVersion: '11.2.1', wpVersion: '7.0' },
    settings: { manage_stock: 'yes', notify_low_stock_amount: 2 },
    keys: opts.keys ?? [],
    products: [
      p({ id: 101, name: 'Oak Cutting Board', slug: 'oak-cutting-board', sku: 'NW-OCB', regular_price: '42.00', stock_quantity: 0, backorders: 'notify' }),
      p({ id: 102, name: 'Linen Apron', slug: 'linen-apron', sku: 'NW-LA', regular_price: '28.00', stock_quantity: -3, backorders: 'no' }),
      p({ id: 103, name: 'Spring Seed Kit', slug: 'spring-seed-kit', sku: 'NW-SSK', regular_price: '19.00', stock_quantity: 0, backorders: 'yes', tags: ['preorder'] }),
      p({ id: 104, name: 'Copper Kettle', slug: 'copper-kettle', sku: 'NW-CK', regular_price: '89.00', stock_quantity: 2, backorders: 'no' }),
      p({ id: 105, name: 'Wool Throw', slug: 'wool-throw', sku: '', regular_price: '120.00', stock_quantity: 12, backorders: 'no' }),
      p({ id: 106, name: 'Stoneware Mug', slug: 'stoneware-mug', sku: 'NW-SM', regular_price: '16.00', status: 'draft', stock_quantity: 30 }),
      p({ id: 107, name: 'Holiday Candle', slug: 'holiday-candle', sku: 'NW-HC', regular_price: '24.00', status: 'future', stock_quantity: 50 }),
      p({ id: 108, name: 'Walnut Tray', slug: 'walnut-tray', sku: 'NW-WT', regular_price: '55.00', sale_price: '49.00', stock_quantity: 8 }),
      p({
        id: 110, name: 'Canvas Tote', slug: 'canvas-tote', type: 'variable', sku: 'NW-CT', regular_price: '', manage_stock: false, stock_quantity: null,
        variations: [
          { id: 111, sku: 'NW-CT-S', status: 'publish', regular_price: '22.00', sale_price: '', manage_stock: true, stock_quantity: 0, backorders: 'yes', attributes: [{ name: 'Size', option: 'Small' }] },
          { id: 112, sku: 'NW-CT-L', status: 'publish', regular_price: '26.00', sale_price: '', manage_stock: true, stock_quantity: 9, backorders: 'no', attributes: [{ name: 'Size', option: 'Large' }] },
        ],
      }),
      p({
        id: 120, name: 'Beeswax Wraps', slug: 'beeswax-wraps', type: 'variable', sku: 'NW-BW', regular_price: '', manage_stock: true, stock_quantity: 0, backorders: 'notify',
        variations: [
          { id: 121, sku: 'NW-BW-3', status: 'publish', regular_price: '18.00', sale_price: '', manage_stock: 'parent', stock_quantity: null, backorders: 'no', attributes: [{ name: 'Pack', option: '3 pack' }] },
          { id: 122, sku: 'NW-BW-6', status: 'publish', regular_price: '30.00', sale_price: '', manage_stock: 'parent', stock_quantity: null, backorders: 'no', attributes: [{ name: 'Pack', option: '6 pack' }] },
        ],
      }),
    ],
    webhooks: [], faults: [], writeLog: [], requestLog: [], nextId: 9001,
  }
}
