import { AgentsScreen } from '@/components/store/Agents'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'

export const metadata = { title: 'Agents' }

export default function ShopifyAgentsPage() {
  requireEmbeddedFeature('agents')
  return <AgentsScreen />
}
