import { ActivityScreen } from '@/components/store/Activity'

export const metadata = { title: 'Activity' }

export default async function StoreActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  return <ActivityScreen initialOutcome={sp.outcome} />
}
