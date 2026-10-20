import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { creditStatus } from '@/lib/assessments/credit'
import { leaksTotal } from '@/lib/assessments/queries'
import { money, type Leak } from '@/lib/leaks'
import { PageHeader } from '@/components/ui/PageHeader'
import { Tile } from '@/components/ui/Tile'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'

export const metadata = { title: 'Agency' }
export const dynamic = 'force-dynamic'

type Agency = { id: string; name: string; city: string | null; county: string | null; state: string; timezone: string; assessment_credit_cents: number; assessment_credit_expires_at: string | null; assessment_credit_applied_at: string | null; prospect_id: string | null; prospect_stage: string | null; prospect_updated_at: string | null; owner_name: string | null; created_at: string }
type A = { id: string; status: string; leaks: Leak[]; recommended_door: string | null; report_generated_at: string | null; created_at: string }

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')

export default async function AgencyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await requireRole('staff')
  const ip = await requestIp()
  const data = await withUser(session, async db => {
    const g = await db.one<Agency>(
      `select g.*, p.stage as prospect_stage, p.updated_at as prospect_updated_at, p.owner_name
       from agencies g left join prospects p on p.id = g.prospect_id or p.agency_id = g.id where g.id = $1 limit 1`, [id])
    if (!g) return null
    const assessments = await db.query<A>('select id, status, leaks, recommended_door, report_generated_at, created_at from assessments where agency_id = $1 order by created_at desc', [id])
    const users = await db.query<{ email: string }>('select email from profiles where agency_id = $1 order by email', [id])
    return { g, assessments, users }
  }, { ip })
  if (!data) notFound()
  const { g, assessments, users } = data
  const status = creditStatus(g, g.prospect_stage, g.prospect_updated_at)
  const tone = status === 'available' ? 'ok' : status === 'applied' ? 'ok' : status === 'expired' ? 'danger' : 'muted'
  const daysLeft = g.assessment_credit_expires_at ? Math.ceil((new Date(g.assessment_credit_expires_at).getTime() - Date.now()) / 86400e3) : null

  return (
    <>
      <PageHeader eyebrow={<Link href="/staff/assessments">Assessments</Link>} title={g.name}
        sub={`${[g.city, g.county && `${g.county} County`, g.state].filter(Boolean).join(' · ')}${g.owner_name ? ` · ${g.owner_name}` : ''}`}
        actions={<>{g.prospect_id && <Link className="btn ghost sm" href={`/staff/pipeline/${g.prospect_id}`}>Prospect</Link>}<Link className="btn ghost sm" href="/app/home">Client dashboard</Link></>} />

      <section className="grid gap-4 md:grid-cols-3">
        <Tile label="Assessment credit" value={g.assessment_credit_cents ? money(g.assessment_credit_cents / 100) : '—'} icon="dollar"
          sub={<><Badge tone={tone}>{status}</Badge>{status === 'available' && daysLeft != null ? <span className="ml-2">{daysLeft} days left</span> : null}</>} />
        <Tile label="Credit expires" value={date(g.assessment_credit_expires_at)} icon="clock" sub={g.assessment_credit_applied_at ? `applied ${date(g.assessment_credit_applied_at)}` : 'build must be sold before this date'} />
        <Tile label="Pipeline stage" value={g.prospect_stage ? g.prospect_stage.replace(/_/g, ' ') : '—'} icon="pipeline" sub={users.length ? `${users.length} client user${users.length === 1 ? '' : 's'}` : 'no client users yet'} />
      </section>

      <section className="mt-10">
        <h2 className="mb-4">Assessments</h2>
        {assessments.length === 0 ? <Empty title="No assessments for this agency" /> : (
          <ul className="flex flex-col gap-3">
            {assessments.map(a => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-line p-4">
                <div>
                  <div className="text-ink font-medium">{date(a.created_at)} · {a.status.replace(/_/g, ' ')}</div>
                  <div className="text-[14px]">{a.leaks?.length ? `${money(leaksTotal(a.leaks))} / yr · door: ${a.recommended_door}` : 'leaks not calculated'}{a.report_generated_at ? ` · PDF ${date(a.report_generated_at)}` : ''}</div>
                </div>
                <div className="flex gap-2">
                  <Link className="btn ghost xs" href={`/staff/assessments/${a.id}`}>Walkthrough</Link>
                  <Link className="btn ghost xs" href={`/staff/assessments/${a.id}/report`}>Report</Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="mb-4">Client users</h2>
        {users.length === 0 ? <Empty title="No client users yet">Invite the owner by email from Supabase Auth; the profile attaches to this agency.</Empty> : (
          <ul className="flex flex-col gap-2 text-[15px]">{users.map(u => <li key={u.email} className="text-ink">{u.email}</li>)}</ul>
        )}
      </section>
    </>
  )
}
