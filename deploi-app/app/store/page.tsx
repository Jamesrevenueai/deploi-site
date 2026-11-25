import { CommandCenter } from '@/components/app/command/CommandCenter'
import { commandStats } from '@/lib/app/command-stats'
import { loadCommandCenter, loadShell, loadWorkspace, merchantSession, orgTimeZone, orgStopped } from '@/lib/app/shell'

export const metadata = { title: 'Command center' }
export const dynamic = 'force-dynamic'

/** The Command center (design-ref/app-command-center.html): the side (Store or Office) this person chose, read once. */
export default async function CommandCenterPage() {
  const { session, actor } = await merchantSession()
  const workspace = await loadWorkspace(actor)
  const timeZone = await orgTimeZone(actor.orgId)
  const now = new Date()
  const [data, stopped, shell, stats] = await Promise.all([loadCommandCenter(actor, workspace), orgStopped(actor.orgId), loadShell(actor), commandStats(actor, workspace, { now, timeZone })])
  return <CommandCenter data={data} stats={stats} workspaceName={shell.workspaceName} now={now.toISOString()} timeZone={timeZone} stopped={stopped} canAct={session.orgRole !== 'viewer'} />
}
