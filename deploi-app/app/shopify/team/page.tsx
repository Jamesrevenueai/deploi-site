import { TeamScreen } from '@/components/team/TeamScreen'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'
export const metadata = { title: 'Your team' }
export default function ShopifyTeamPage() { requireEmbeddedFeature('team'); return <TeamScreen /> }
