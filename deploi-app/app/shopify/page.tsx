import { OverviewScreen } from '@/components/store/Overview'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'

export const metadata = { title: 'Overview' }

export default function ShopifyOverviewPage() {
  requireEmbeddedFeature('overview')
  return <OverviewScreen />
}
