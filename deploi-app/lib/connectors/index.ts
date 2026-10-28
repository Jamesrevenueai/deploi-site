/** Registers every connector and check with the engine. Import once wherever the engine runs. */
import { registerConnector, registerCheck } from '../engine/registry'
import { shopifyConnector } from './shopify/connector'
import { oversellPolicyCheck, oversoldCheck } from './shopify/checks'
import { publicationCheck, priceCheck, skuCheck } from './shopify/listing-checks'
import { plannedConnectors } from './planned'
import { wooBackordersCheck, wooOversoldCheck } from './woocommerce/checks'
import { amazonListingErrorsCheck } from './amazon/checks'

registerConnector(shopifyConnector)
registerCheck(oversellPolicyCheck)
registerCheck(oversoldCheck)
registerCheck(publicationCheck)
registerCheck(priceCheck)
registerCheck(skuCheck)
for (const c of plannedConnectors) registerConnector(c)
// planned platforms: checks are registered so they can be tested and described; their connectors refuse every call
registerCheck(wooBackordersCheck)
registerCheck(wooOversoldCheck)
registerCheck(amazonListingErrorsCheck)

export { shopifyConnector }
