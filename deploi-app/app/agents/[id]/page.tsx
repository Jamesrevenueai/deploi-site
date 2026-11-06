import { notFound, redirect } from 'next/navigation'
import { requireRole } from '@/lib/auth'
import { agentDashboard, chatHistory } from '@/lib/app/contract'
import { isEngineError } from '@/lib/engine/errors'
import { AgentDashboard } from '@/components/app/agent/AgentDashboard'
import { actorOf, agentIdFrom } from '@/components/app/agent/actor'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Agent' }

/** One agent's dashboard. The organization comes from the session; an id that is not one of its agents is a 404. */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireRole('client')
  if (session.orgType !== 'merchant') redirect(session.agencyId ? '/no-store' : '/start')
  const actor = actorOf(session)
  if (!actor) redirect('/no-store')
  const id = agentIdFrom((await params).id)
  if (!id) notFound()
  const loaded = await Promise.all([agentDashboard(actor, id), chatHistory(actor, id)]).catch((e: unknown) => {
    if (isEngineError(e) && e.code === 'not_found') return null
    throw e
  })
  if (!loaded) notFound()
  const [dashboard, history] = loaded
  return <AgentDashboard initial={dashboard} history={history} />
}
