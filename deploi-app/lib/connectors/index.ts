/** Registers every connector and check with the engine. Import once wherever the engine runs. */
import { registerConnector, registerCheck } from '../engine/registry'
import { registerCapabilities } from '../engine/capabilities'
import { shopifyConnector } from './shopify/connector'
import { OVERSELL_CHECK, OVERSOLD_CHECK, oversellPolicyCheck, oversoldCheck } from './shopify/checks'
import { PRICE_CHECK, PUBLICATION_CHECK, SKU_CHECK, publicationCheck, priceCheck, skuCheck } from './shopify/listing-checks'
import { plannedConnectors } from './planned'
import { WOO_BACKORDERS_CHECK, WOO_LOW_STOCK_CHECK, WOO_OVERSOLD_CHECK, wooBackordersCheck, wooLowStockCheck, wooOversoldCheck } from './woocommerce/checks'
import { WOO_PRICE_CHECK, WOO_PUBLICATION_CHECK, WOO_SKU_CHECK, WOO_PUBLISH, WOO_UNPUBLISH, WOO_SET_PRICE, WOO_SET_COMPARE_AT, WOO_SET_SKU, wooPriceCheck, wooPublicationCheck, wooSkuCheck } from './woocommerce/listing-checks'
import { wooConnector } from './woocommerce/connector'
import { OVERSOLD_WATCH } from '../agents/watch'
import { amazonListingErrorsCheck } from './amazon/checks'

registerConnector(shopifyConnector)
registerCheck(oversellPolicyCheck)
registerCheck(oversoldCheck)
registerCheck(publicationCheck)
registerCheck(priceCheck)
registerCheck(skuCheck)
// what an agent may do on Shopify, in platform-neutral terms (agents and permissions never name Shopify actions)
registerCapabilities('shopify', {
  corrections: [
    { type: 'oversell_policy', checkKey: OVERSELL_CHECK, actions: { 'shopify.variant.set_inventory_policy': 'inventoryPolicy' } },
    { type: 'publication', checkKey: PUBLICATION_CHECK, actions: { 'shopify.product.publish': 'published', 'shopify.product.unpublish': 'published' } },
    { type: 'price', checkKey: PRICE_CHECK, actions: { 'shopify.variant.set_price': 'price', 'shopify.variant.set_compare_at_price': 'compareAtPrice' } },
    { type: 'sku', checkKey: SKU_CHECK, actions: { 'shopify.variant.set_sku': 'sku' } },
  ],
  watch: [{ checkKey: OVERSOLD_CHECK, label: 'oversold variants (negative available stock while still selling)' }],
})
// WooCommerce: operational (REST v3 with a merchant-approved read_write key); same neutral correction types as Shopify
registerConnector(wooConnector)
registerCheck(wooBackordersCheck)
registerCheck(wooOversoldCheck)
registerCheck(wooLowStockCheck)
registerCheck(wooPublicationCheck)
registerCheck(wooPriceCheck)
registerCheck(wooSkuCheck)
registerCapabilities('woocommerce', {
  corrections: [
    { type: 'oversell_policy', checkKey: WOO_BACKORDERS_CHECK, actions: { 'woocommerce.product.set_backorders': 'backorders' } },
    { type: 'publication', checkKey: WOO_PUBLICATION_CHECK, actions: { [WOO_PUBLISH]: 'published', [WOO_UNPUBLISH]: 'published' } },
    { type: 'price', checkKey: WOO_PRICE_CHECK, actions: { [WOO_SET_PRICE]: 'price', [WOO_SET_COMPARE_AT]: 'compareAtPrice' } },
    { type: 'sku', checkKey: WOO_SKU_CHECK, actions: { [WOO_SET_SKU]: 'sku' } },
  ],
  // the templates name the oversold watch by its Shopify key; on WooCommerce the same watch runs WooCommerce's check
  watch: [
    { checkKey: WOO_OVERSOLD_CHECK, label: 'oversold items (stock below zero while backorders are off)', aliases: [OVERSOLD_WATCH] },
    { checkKey: WOO_LOW_STOCK_CHECK, label: 'low stock (at or below the WooCommerce low-stock threshold)' },
  ],
})
for (const c of plannedConnectors) registerConnector(c)
// planned platforms: checks are registered so they can be tested and described; their connectors refuse every call
registerCheck(amazonListingErrorsCheck)

export { shopifyConnector, wooConnector }
