/** Registers every connector and check with the engine. Import once wherever the engine runs. */
import { registerConnector, registerCheck } from '../engine/registry'
import { shopifyConnector } from './shopify/connector'
import { oversellPolicyCheck, oversoldCheck } from './shopify/checks'
import { plannedConnectors } from './planned'

registerConnector(shopifyConnector)
registerCheck(oversellPolicyCheck)
registerCheck(oversoldCheck)
for (const c of plannedConnectors) registerConnector(c)

export { shopifyConnector }
