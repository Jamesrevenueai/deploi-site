import { IssueDetailScreen } from '@/components/store/IssueDetail'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'

export const metadata = { title: 'Issue' }

export default async function ShopifyIssuePage({ params }: { params: Promise<{ id: string }> }) {
  requireEmbeddedFeature('issues')
  const { id } = await params
  return <IssueDetailScreen id={id} />
}
