/** Registers every connector and check with the engine. Import once wherever the engine runs. */
import { registerConnector, registerCheck } from '../engine/registry'
import { registerCapabilities } from '../engine/capabilities'
import { shopifyConnector } from './shopify/connector'
import { OVERSELL_CHECK, OVERSOLD_CHECK, oversellPolicyCheck, oversoldCheck } from './shopify/checks'
import { PRICE_CHECK, PUBLICATION_CHECK, SKU_CHECK, publicationCheck, priceCheck, skuCheck } from './shopify/listing-checks'
import { plannedConnectors } from './planned'
import { WOO_BACKORDERS_CHECK, wooBackordersCheck, wooOversoldCheck } from './woocommerce/checks'
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
for (const c of plannedConnectors) registerConnector(c)
// planned platforms: checks are registered so they can be tested and described; their connectors refuse every call
registerCheck(wooBackordersCheck)
registerCheck(wooOversoldCheck)
registerCheck(amazonListingErrorsCheck)
// declared now so the agent builder can name them; the connector refuses every call until it is built and verified
registerCapabilities('woocommerce', { corrections: [{ type: 'oversell_policy', checkKey: WOO_BACKORDERS_CHECK, actions: { 'woocommerce.product.set_backorders': 'backorders' } }] })

export { shopifyConnector }
