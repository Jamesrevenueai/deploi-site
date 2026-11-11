import { PrivacyScreen } from '@/app/store/privacy/PrivacyScreen'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'

export const metadata = { title: 'Privacy requests' }

/** Shopify's customer data requests and erasures, inside the admin: a Shopify-only merchant downloads exports here. */
export default function ShopifyPrivacyPage() {
  requireEmbeddedFeature('privacy')
  return <PrivacyScreen />
}
