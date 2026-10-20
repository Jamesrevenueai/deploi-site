import { requireRole } from '@/lib/auth'
import { PageHeader } from '@/components/ui/PageHeader'
import { Empty } from '@/components/ui/Empty'
import { EvvView, type Tab } from '@/components/evv/EvvView'

export const metadata = { title: 'EVV exceptions' }
export const dynamic = 'force-dynamic'

export default async function ClientEvv({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('client')
  const tab = (['open', 'corrected', 'hold'].includes(sp.tab ?? '') ? sp.tab : 'open') as Tab
  if (!session.agencyId) return <><PageHeader title="EVV exceptions" /><Empty title="No agency on this account">Ask Deploi to link your user to your agency.</Empty></>
  return (
    <>
      <PageHeader title="EVV exceptions" sub="Soonest correction window first. Mark each one corrected in your EVV system and it leaves the billing hold." />
      <EvvView session={session} agencyId={session.agencyId} tab={tab} basePath="/app/evv" />
    </>
  )
}
