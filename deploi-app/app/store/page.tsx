import { CommandCenter } from '@/components/app/command/CommandCenter'
import { loadCommandCenter, loadWorkspace, merchantSession, orgTimeZone, orgStopped } from '@/lib/app/shell'

export const metadata = { title: 'Command center' }
export const dynamic = 'force-dynamic'

/** The Command center: the side (Store or Office) this person chose, read once with the shell (lib/app/shell.ts). */
export default async function CommandCenterPage() {
  const { session, actor } = await merchantSession()
  const [data, timeZone, stopped] = await Promise.all([loadWorkspace(actor).then(w => loadCommandCenter(actor, w)), orgTimeZone(actor.orgId), orgStopped(actor.orgId)])
  return <CommandCenter data={data} now={new Date().toISOString()} timeZone={timeZone} stopped={stopped} canAct={session.orgRole !== 'viewer'} />
}
