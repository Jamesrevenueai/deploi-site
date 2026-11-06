import { WeeklyScreen } from '@/components/store/Weekly'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'

export const metadata = { title: 'Weekly summary' }

export default function ShopifyWeeklyPage() {
  requireEmbeddedFeature('weekly')
  return <WeeklyScreen />
}
