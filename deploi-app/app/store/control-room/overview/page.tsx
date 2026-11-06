import { OverviewScreen } from '@/components/store/Overview'

export const metadata = { title: 'Store overview' }

/** The store overview (scan, the one setup question, counts by outcome, platforms, subscription). */
export default function StoreOverviewPage() {
  return <OverviewScreen />
}
