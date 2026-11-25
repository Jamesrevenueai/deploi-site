import { PageHeader } from '@/components/ui/PageHeader'
import { CrewToday } from '@/components/work/Crew'

export const metadata = { title: "Today's crew jobs" }

export default function CrewJobsPage() {
  return (
    <>
      <PageHeader title="Today's crew jobs" sub="Who has which job, where, and whether it is done. Crew members mark jobs done from their message." />
      <CrewToday />
    </>
  )
}
