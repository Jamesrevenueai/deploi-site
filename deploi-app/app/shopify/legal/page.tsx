import { LegalScreen } from '@/app/store/legal/LegalScreen'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'

export const metadata = { title: 'Agreements' }

/** The agreements to accept, inside the admin (shown only while LEGAL_GATE asks for acceptance). */
export default function ShopifyLegalPage() {
  requireEmbeddedFeature('legal')
  return <LegalScreen />
}
