import { TeamRoom } from '@/components/app/room/TeamRoom'
import { teamRoom } from '@/lib/app/contract'
import { loadCommandCenter, loadWorkspace, merchantSession } from '@/lib/app/shell'

export const metadata = { title: 'Team room' }
export const dynamic = 'force-dynamic'

/** The team room for the side (Store or Office) this person chose. */
export default async function TeamRoomPage() {
  const { session, actor } = await merchantSession()
  const workspace = await loadWorkspace(actor)
  const [messages, cc] = await Promise.all([teamRoom(actor, workspace), loadCommandCenter(actor, workspace)])
  return <TeamRoom messages={messages} team={cc.team} workspace={workspace} canAct={session.orgRole !== 'viewer'} />
}
