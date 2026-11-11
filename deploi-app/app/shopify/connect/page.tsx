import { ConnectScreen } from '@/components/store/Connect'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'

export const metadata = { title: 'Store connection' }

export default function ShopifyConnectPage() {
  requireEmbeddedFeature('connect')
  return <ConnectScreen />
}
