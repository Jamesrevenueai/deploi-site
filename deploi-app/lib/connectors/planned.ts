/**
 * WooCommerce and Amazon are planned. Their connectors are registered so the engine and UI can
 * name them, but every call refuses with NotOperational until the connector is built and verified.
 * See docs/platform-research/ and docs/capability-matrix.md for what each will do.
 */
import { NotOperational, type Connector, type Platform } from '../engine/types'

function planned(platform: Platform, read: string[], actions: Record<string, string[]>): Connector {
  return {
    platform,
    operational: false,
    requiredScopes: { read, actions },
    async *listResources() { throw new NotOperational(platform) },
    async readResources() { throw new NotOperational(platform) },
    async applyAction() { throw new NotOperational(platform) },
  }
}

export const plannedConnectors: Connector[] = [
  planned('woocommerce', ['read'], { 'woocommerce.product.set_backorders': ['write'] }),
  planned('amazon', ['Product Listing', 'Inventory and Order Tracking'], { 'amazon.listing.patch': ['Product Listing'] }),
]
