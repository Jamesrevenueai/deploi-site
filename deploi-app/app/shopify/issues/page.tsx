import { IssuesScreen } from '@/components/store/IssuesList'
import { requireEmbeddedFeature } from '@/lib/shopify/embedded'

export const metadata = { title: 'Issues' }

export default async function ShopifyIssuesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  requireEmbeddedFeature('issues')
  const sp = await searchParams
  return <IssuesScreen initialStatus={sp.status} initialKind={sp.kind} />
}
