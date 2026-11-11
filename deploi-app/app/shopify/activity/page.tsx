import { ActivityScreen } from '@/components/store/Activity'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'

export const metadata = { title: 'Activity' }

export default async function ShopifyActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  requireEmbeddedFeature('activity')
  const sp = await searchParams
  return <ActivityScreen initialOutcome={sp.outcome} />
}
