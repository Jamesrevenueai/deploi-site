import { IssueDetailScreen } from '@/components/store/IssueDetail'

export const metadata = { title: 'Issue' }

export default async function StoreIssuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <IssueDetailScreen id={id} />
}
