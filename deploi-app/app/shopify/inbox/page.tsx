import { InboxScreen } from '@/components/store/Inbox'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'

export const metadata = { title: 'Approvals' }

export default function ShopifyInboxPage() {
  requireEmbeddedFeature('approvals')
  return <InboxScreen />
}
