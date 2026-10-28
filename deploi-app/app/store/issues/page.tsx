import { IssuesScreen } from '@/components/store/IssuesList'

export const metadata = { title: 'Issues' }

export default async function StoreIssuesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  return <IssuesScreen initialStatus={sp.status} initialKind={sp.kind} />
}
