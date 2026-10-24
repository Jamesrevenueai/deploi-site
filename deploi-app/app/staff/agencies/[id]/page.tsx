import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { creditState, daysLeft as creditDaysLeft } from '@/lib/credit/label'
import { listCredits, listApplications, remainingCents, type CreditRow, type CreditApplicationRow } from '@/lib/credit/ledger'
import { leaksTotal } from '@/lib/assessments/queries'
import { money, type Leak } from '@/lib/leaks'
import { PageHeader } from '@/components/ui/PageHeader'
import { Tile } from '@/components/ui/Tile'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Empty } from '@/components/ui/Empty'
import { CreditPanel } from '@/components/assessments/CreditPanel'

export const metadata = { title: 'Agency' }
export const dynamic = 'force-dynamic'

type Agency = { id: string; name: string; city: string | null; county: string | null; state: string; timezone: string; assessment_credit_cents: number; assessment_credit_expires_at: string | null; assessment_credit_applied_at: string | null; credit_expires_at: string | null; credit_expired: boolean; prospect_id: string | null; prospect_stage: string | null; prospect_updated_at: string | null; owner_name: string | null; created_at: string }
type A = { id: string; status: string; leaks: Leak[]; recommended_door: string | null; report_generated_at: string | null; created_at: string }

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')

export default async function AgencyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params
  const sp = await searchParams
  const session = await requireRole('staff')
  const ip = await requestIp()
  const data = await withUser(session, async db => {
    const g = await db.one<Agency>(
      `select g.*, p.stage as prospect_stage, p.updated_at as prospect_updated_at, p.owner_name
       from agencies g left join prospects p on p.id = g.prospect_id or p.agency_id = g.id where g.id = $1 limit 1`, [id])
    if (!g) return null
    const assessments = await db.query<A>('select id, status, leaks, recommended_door, report_generated_at, created_at from assessments where agency_id = $1 order by created_at desc', [id])
    const users = await db.query<{ email: string }>('select email from profiles where agency_id = $1 order by email', [id])
    const credits = await listCredits(db, id)
    const apps: Record<string, CreditApplicationRow[]> = {}
    for (const c of credits) apps[c.id] = await listApplications(db, c.id)
    return { g, assessments, users, credits, apps }
  }, { ip })
  if (!data) notFound()
  const { g, assessments, users, credits, apps } = data
  // The ledger is the truth; the legacy columns only cover agencies that predate the ledger.
  const latest: CreditRow | null = credits[0] ?? null
  const status = creditState(latest ?? g)
  const tone = status === 'available' || status === 'applied' || status === 'partially_applied' ? 'ok' : status === 'expired' || status === 'refunded' ? 'danger' : status === 'unpaid' ? 'warn' : 'muted'
  const daysLeft = creditDaysLeft(latest ?? g)
  const mock = latest?.payment_status === 'mock_paid'
  const creditError = sp.error?.startsWith('credit-') ? sp.error.replace(/^credit-/, '').replace(/_/g, ' ') : null

  return (
    <>
      <PageHeader eyebrow={<Link href="/staff/assessments">Assessments</Link>} title={g.name}
        sub={`${[g.city, g.county && `${g.county} County`, g.state].filter(Boolean).join(' · ')}${g.owner_name ? ` · ${g.owner_name}` : ''}`}
        actions={<>{g.prospect_id && <Link className="btn ghost sm" href={`/staff/pipeline/${g.prospect_id}`}>Prospect</Link>}<Link className="btn ghost sm" href="/app/home">Client dashboard</Link></>} />

      {sp.credit && <div className="mb-6"><Banner icon="dollar"><strong>{sp.credit === 'paid' ? 'Payment recorded.' : 'Simulated payment recorded.'}</strong> {sp.credit === 'paid' ? 'The credit is now available for a qualifying build.' : 'It is simulated: the credit stays unusable until a real payment is recorded.'}</Banner></div>}
      {creditError && <div className="mb-6"><Banner tone="warn"><strong>Credit action refused.</strong> {creditError}.</Banner></div>}

      <section className="grid gap-4 md:grid-cols-3">
        <Tile label="Assessment credit" value={latest ? money(latest.credit_cents / 100) : g.assessment_credit_cents ? money(g.assessment_credit_cents / 100) : '—'} icon="dollar"
          sub={<><Badge tone={tone}>{status.replace(/_/g, ' ')}</Badge>{mock && <Badge tone="warn">simulated</Badge>}{status === 'available' && daysLeft != null ? <span className="ml-2">{daysLeft} days left</span> : null}{latest ? <span className="ml-2">{money(remainingCents(latest) / 100)} remaining</span> : null}</>} />
        <Tile label="Credit expires" value={date(latest?.expires_at ?? g.credit_expires_at ?? g.assessment_credit_expires_at)} icon="clock"
          sub={latest ? (latest.payment_status === 'paid' && !latest.payment_is_mock ? `paid ${date(latest.paid_at)}` : 'fee payment not yet recorded') : g.assessment_credit_applied_at ? `applied ${date(g.assessment_credit_applied_at)}` : g.credit_expired ? 'expired before a build was sold; no override' : 'build must be sold before this date'} />
        <Tile label="Pipeline stage" value={g.prospect_stage ? g.prospect_stage.replace(/_/g, ' ') : '—'} icon="pipeline" sub={users.length ? `${users.length} client user${users.length === 1 ? '' : 's'}` : 'no client users yet'} />
      </section>

      <section className="mt-10 flex flex-col gap-4">
        <h2>Credit ledger</h2>
        {credits.length === 0 ? <CreditPanel credit={null} applications={[]} back={`/staff/agencies/${id}`} /> : credits.map(c => (
          <CreditPanel key={c.id} credit={c} applications={apps[c.id] ?? []} back={`/staff/agencies/${id}`} />
        ))}
      </section>

      <section className="mt-10">
        <h2 className="mb-4">Assessments</h2>
        {assessments.length === 0 ? <Empty title="No assessments for this agency" /> : (
          <ul className="flex flex-col gap-3">
            {assessments.map(a => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[20px] border border-line p-4">
                <div>
                  <div className="text-ink font-medium">{date(a.created_at)} · {a.status.replace(/_/g, ' ')}</div>
                  <div className="text-[14px]">{a.leaks?.length ? `${money(leaksTotal(a.leaks))} / yr across the principal leaks · door: ${a.recommended_door}` : 'leaks not calculated'}{a.report_generated_at ? ` · PDF ${date(a.report_generated_at)}` : ''}</div>
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
