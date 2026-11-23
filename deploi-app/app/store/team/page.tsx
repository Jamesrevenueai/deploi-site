import { TeamScreen } from '@/components/team/TeamScreen'
import { loadWorkspace, merchantSession } from '@/lib/app/shell'
import { admin } from '@/lib/db'
import { planOf } from '@/lib/metering'

export const metadata = { title: 'Agent library' }
export const dynamic = 'force-dynamic'

/** The Agent library (design-ref/app-agent-library.html), for the side (Store or Office) this person chose. */
export default async function StoreTeamPage() {
  const { actor } = await merchantSession()
  const workspace = await loadWorkspace(actor)
  const plan = workspace === 'office' ? await admin(db => planOf(db, actor.orgId)) : null
  return <TeamScreen workspace={workspace} officePlan={plan} />
}
