import { PageHeader } from '@/components/ui/PageHeader'
import { CrewSettings } from '@/components/work/Crew'

export const metadata = { title: 'Crew' }

export default function CrewSettingsPage() {
  return (
    <>
      <PageHeader title="Crew" sub="Packers, warehouse staff and field crew. Agents send them their jobs; they tap Mark done when finished, and the next step runs." />
      <CrewSettings />
    </>
  )
}
