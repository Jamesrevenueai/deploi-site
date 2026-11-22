import { ConnectionsScreen } from '@/components/store/Connections'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'

export const metadata = { title: 'Connections' }

export default function ShopifyConnectionsPage() {
  requireEmbeddedFeature('connections')
  return <ConnectionsScreen />
}
