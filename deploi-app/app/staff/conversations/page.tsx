import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { getConversationGate, listHeld } from '@/lib/sales/conversations'
import { STAGE_LABEL, type Stage } from '@/lib/sales/stages'
import { PageHeader } from '@/components/ui/PageHeader'
import { Tile } from '@/components/ui/Tile'
import { Empty } from '@/components/ui/Empty'
import Link from 'next/link'

export const metadata = { title: 'Owner conversations' }
export const dynamic = 'force-dynamic'

export default async function ConversationsPage() {
  const session = await requireRole('staff')
  const { gate, held } = await withUser(session, async db => ({ gate: await getConversationGate(db), held: await listHeld(db) }), { ip: await requestIp() })
  const pct = Math.min(100, Math.round((gate.held / gate.goal) * 100))
  return (
    <>
      <PageHeader title="Owner conversations" sub="Held discovery calls toward the goal of 10. The biggest-leak column is the pattern to read. Reaching 10 opens EVV connector work." />
      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Tile label="Conversations held" value={`${gate.held} / ${gate.goal}`} sub={gate.open ? 'Gate open: start EVV connector work.' : `${gate.goal - gate.held} more to open the EVV connector gate.`} icon="phone" tone={gate.open ? 'ok' : 'none'}>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[#1a1a1a]" role="progressbar" aria-valuemin={0} aria-valuemax={gate.goal} aria-valuenow={gate.held} aria-label="Progress to 10">
            <div className="h-full bg-white" style={{ width: `${pct}%` }} />
          </div>
        </Tile>
        <Tile label="Leaks named" value={held.filter(h => h.biggest_leak).length} sub="Calls where the owner named a specific leak." icon="spark" />
      </div>
      {held.length === 0 ? <Empty title="No held conversations yet">Log a call with outcome “held” on a prospect.</Empty> : (
        <>
          <div className="table-wrap hidden md:block">
            <table className="dg-table">
              <thead><tr><th>#</th><th>Agency</th><th>Owner</th><th>Held</th><th>Stage</th><th>Biggest leak they named</th></tr></thead>
              <tbody>
                {held.map((h, i) => (
                  <tr key={h.id}>
                    <td>{i + 1}</td>
                    <td className="ink"><Link href={`/staff/pipeline/${h.id}`}>{h.agency_name}</Link></td>
                    <td>{h.owner_name ?? '—'}</td>
                    <td className="whitespace-nowrap">{new Date(h.held_at).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}</td>
                    <td>{STAGE_LABEL[h.stage as Stage] ?? h.stage}</td>
                    <td className="ink">{h.biggest_leak ?? <span className="text-grey-h">not captured</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ol className="flex flex-col gap-3 md:hidden">
            {held.map((h, i) => (
              <li key={h.id} className="rounded-2xl border border-line p-4">
                <div className="flex items-center justify-between text-[13px] text-grey-h"><span>#{i + 1} · {new Date(h.held_at).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}</span><span>{STAGE_LABEL[h.stage as Stage] ?? h.stage}</span></div>
                <Link href={`/staff/pipeline/${h.id}`} className="mt-1 block text-[16px] font-medium text-ink">{h.agency_name}</Link>
                <div className="text-[13px] text-grey">{h.owner_name ?? '—'}</div>
                <div className="mt-2 text-[15px] text-ink">{h.biggest_leak ?? <span className="text-grey-h">leak not captured</span>}</div>
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  )
}
