import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'
import { MobileRows } from '@/components/dashboard/MobileRows'

export const metadata = { title: 'Applicants' }
export const dynamic = 'force-dynamic'

type Row = { id: string; first_name: string; last_name: string; applied_at: string; source: string; status: string; screen_score: number | null; interview_at: string | null; screen_answers: Record<string, unknown> }
const TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted' | 'none'> = { new: 'warn', screened: 'none', interview_booked: 'ok', hired: 'ok', rejected: 'muted' }

export default async function Applicants() {
  const session = await requireRole('client')
  const ip = await requestIp()
  const { rows, tz } = await withUser(session, async db => {
    const rows = await db.query<Row>(
      `select id, first_name, last_name, applied_at, source, status, screen_score, interview_at, screen_answers
       from applicants where agency_id = $1 order by applied_at desc limit 200`, [session.agencyId])
    await db.auditRead('applicants', session.agencyId, rows.map(r => r.id))
    const g = await db.one<{ timezone: string }>('select timezone from agencies where id = $1', [session.agencyId])
    return { rows, tz: g?.timezone ?? 'America/New_York' }
  }, { ip })
  const fmt = (s: string | null) => (s ? new Date(s).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
  const answers = (a: Record<string, unknown>) => Object.keys(a).length ? `STNA ${a.stna ? 'yes' : 'no'} · drives ${a.drives ? 'yes' : 'no'} · ${a.availability ?? '—'} · ${a.county ?? '—'}` : 'not screened yet'

  return (
    <>
      <PageHeader title="Applicants" sub="New applicants, screening results, and booked interviews." />
      {rows.length === 0 ? <Empty title="No applicants yet" /> : (
        <>
          <div className="table-wrap hidden md:block">
            <table className="dg-table">
              <thead><tr><th>Applied</th><th>Name</th><th>Source</th><th>Screen</th><th>Score</th><th>Interview</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{fmt(r.applied_at)}</td>
                    <td className="ink">{r.first_name} {r.last_name}</td>
                    <td>{r.source}</td>
                    <td className="text-[14px]">{answers(r.screen_answers)}</td>
                    <td>{r.screen_score ?? '—'}{r.screen_score != null ? '/4' : ''}</td>
                    <td className="whitespace-nowrap">{fmt(r.interview_at)}</td>
                    <td><Badge tone={TONE[r.status] ?? 'none'}>{r.status.replace('_', ' ')}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <MobileRows rows={rows.map(r => ({
            key: r.id, title: `${r.first_name} ${r.last_name}`, badge: <Badge tone={TONE[r.status] ?? 'none'}>{r.status.replace('_', ' ')}</Badge>,
            lines: [`Applied ${fmt(r.applied_at)} via ${r.source}`, answers(r.screen_answers), r.interview_at ? `Interview ${fmt(r.interview_at)}` : `Score ${r.screen_score ?? '—'}`],
          }))} />
        </>
      )}
    </>
  )
}
