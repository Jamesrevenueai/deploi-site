import { RulesScreen } from '@/components/store/Rules'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'

export const metadata = { title: 'Rules' }

export default function ShopifyRulesPage() {
  requireEmbeddedFeature('rules')
  return <RulesScreen />
}
