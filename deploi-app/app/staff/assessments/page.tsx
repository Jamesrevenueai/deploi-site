import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { listAssessments, leaksTotal } from '@/lib/assessments/queries'
import { money } from '@/lib/leaks'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'
import Link from 'next/link'

export const metadata = { title: 'Assessments' }
export const dynamic = 'force-dynamic'

const tone = (s: string) => (s === 'complete' ? 'ok' : s === 'in_progress' ? 'warn' : 'muted') as 'ok' | 'warn' | 'muted'
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—')

export default async function AssessmentsPage() {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const rows = await withUser(session, db => listAssessments(db), { ip })
  return (
    <>
      <PageHeader title="Assessments" sub="One referral and one visit traced end to end, three leaks in dollars, one door recommended." actions={<Button href="/staff/assessments/new" size="sm">New assessment</Button>} />
      {rows.length === 0 ? <Empty title="No assessments yet">Create one from a prospect who bought the Operations Assessment.</Empty> : (
        <>
          <div className="table-wrap hidden md:block">
            <table className="dg-table">
              <thead><tr><th>Agency</th><th>Prospect</th><th>Status</th><th>Leaks / yr</th><th>Door</th><th>Report</th><th></th></tr></thead>
              <tbody>
                {rows.map(a => (
                  <tr key={a.id}>
                    <td className="ink"><Link href={`/staff/agencies/${a.agency_id}`}>{a.agency_name}</Link></td>
                    <td>{a.owner_name ?? '—'}{a.prospect_stage ? <span className="text-grey-h"> · {a.prospect_stage.replace(/_/g, ' ')}</span> : null}</td>
                    <td><Badge tone={tone(a.status)}>{a.status.replace(/_/g, ' ')}</Badge></td>
                    <td className="ink">{a.leaks?.length ? money(leaksTotal(a.leaks)) : '—'}</td>
                    <td>{a.recommended_door ?? '—'}</td>
                    <td>{a.report_generated_at ? <a className="underline" href={`/api/reports/${a.id}`} target="_blank" rel="noopener noreferrer">PDF · {when(a.report_generated_at)}</a> : '—'}</td>
                    <td><Link className="btn ghost xs" href={`/staff/assessments/${a.id}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col gap-3 md:hidden">
            {rows.map(a => (
              <li key={a.id} className="rounded-[20px] border border-line p-4">
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/staff/assessments/${a.id}`} className="text-ink font-medium">{a.agency_name}</Link>
                  <Badge tone={tone(a.status)}>{a.status.replace(/_/g, ' ')}</Badge>
                </div>
                <div className="mt-1 text-[14px]">{a.owner_name ?? '—'} · {a.leaks?.length ? `${money(leaksTotal(a.leaks))} / yr` : 'leaks pending'}</div>
                <div className="mt-3 flex gap-2">
                  <Link className="btn ghost xs" href={`/staff/assessments/${a.id}`}>Walkthrough</Link>
                  <Link className="btn ghost xs" href={`/staff/assessments/${a.id}/report`}>Report</Link>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}
