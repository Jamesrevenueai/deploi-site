import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { getMetrics } from '@/lib/dashboard/metrics'
import { Tile } from '@/components/ui/Tile'
import { ImageCard } from '@/components/ui/Card'
import { Empty } from '@/components/ui/Empty'
import { NeedsHuman } from '@/components/dashboard/NeedsHuman'

export const metadata = { title: 'Morning report' }
export const dynamic = 'force-dynamic'

export default async function Home() {
  const session = await requireRole('client')
  const ip = await requestIp()
  if (!session.agencyId) return <Empty title="No agency on this account">Ask Deploi (hello@getdeploi.com) to link your login to your agency.</Empty>
  const now = new Date()
  const { m, report } = await withUser(session, async db => {
    const m = await getMetrics(db, session.agencyId!, now)
    const report = await db.one<{ id: string; report_generated_at: string | null }>(
      'select id, report_generated_at from assessments where agency_id = $1 and report_path is not null order by report_generated_at desc nulls last limit 1', [session.agencyId])
    return { m, report }
  }, { ip })
  const tz = m.agency.timezone || 'America/New_York'
  const dateLabel = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' })
  const soonest = m.exceptions.openItems[0]

  return (
    <>
      <header className="mb-6 fade-up">
        <div className="text-sm text-grey-h">{dateLabel}</div>
        <h1 className="mt-1">Good morning, {m.agency.name}</h1>
        <p className="mt-2 text-grey">Six numbers, then the three things that need a person.</p>
      </header>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3 fade-up">
        <Tile label="Referrals answered" icon="inbox" href="/app/referrals" value={`${m.referrals.today} / ${m.referrals.week}`}
          sub={`today / 7 days · median ${m.referrals.medianMinutes ?? '—'} min to first response`} tone={m.referrals.unanswered > 0 ? 'warn' : 'none'} />
        <Tile label="Shifts filled" icon="calendar" href="/app/shifts" value={`${m.shifts.open} open`}
          sub={`${m.shifts.filledWeek} filled this week · median ${m.shifts.medianMinutesToFill ?? '—'} min to fill`} tone={m.shifts.open > 0 ? 'warn' : 'ok'} />
        <Tile label="EVV exceptions" icon="shield" href="/app/evv" value={m.exceptions.open}
          sub={`${m.exceptions.fixedToday} fixed today${soonest?.daysLeft != null ? ` · soonest window closes in ${soonest.daysLeft} d` : ''}`}
          tone={soonest?.daysLeft != null && soonest.daysLeft <= 7 ? 'danger' : m.exceptions.open > 0 ? 'warn' : 'ok'}>
          {m.exceptions.openItems.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-2">
              {m.exceptions.openItems.slice(0, 4).map(e => (
                <li key={e.id} className={`badge ${e.daysLeft != null && e.daysLeft <= 7 ? 'danger' : 'muted'}`}>{e.daysLeft ?? '?'} d</li>
              ))}
              {m.exceptions.openItems.length > 4 && <li className="badge muted">+{m.exceptions.openItems.length - 4}</li>}
            </ul>
          )}
        </Tile>
        <Tile label="Authorization units" icon="clipboard" href="/app/authorizations" value={`${m.authorizations.lowPct}%`}
          sub={`${m.authorizations.lowCount} of ${m.authorizations.total} auths at ≤ 15% left · ${m.authorizations.expiring30} expire in 30 days`} tone={m.authorizations.lowCount > 0 ? 'warn' : 'ok'} />
        <Tile label="Applicants" icon="users" href="/app/applicants" value={m.applicants.new}
          sub={`new · ${m.applicants.screened} screened · ${m.applicants.interviewsBooked} interviews booked`} />
        <Tile label="Credential lapses" icon="badge" href="/app/credentials" value={m.credentials.lapsing30}
          sub="in the next 30 days" tone={m.credentials.rows.some(r => r.daysLeft <= 7) ? 'danger' : m.credentials.lapsing30 > 0 ? 'warn' : 'ok'} />
      </div>

      <NeedsHuman items={m.needsHuman} />

      {report && (
        <section className="mt-8 fade-up">
          <ImageCard tag="Assessment" tagIcon="file" title="Your assessment report" ratio="auto" className="min-h-[200px]"
            body={`Generated ${report.report_generated_at ? new Date(report.report_generated_at).toLocaleDateString('en-US', { timeZone: tz, month: 'long', day: 'numeric', year: 'numeric' }) : 'recently'}. Two traces, three leaks in dollars, and the first door we recommend.`}
            facts={[{ icon: 'download', label: 'PDF' }, { icon: 'eye', label: 'Open report' }]} href={`/api/reports/${report.id}`} />
        </section>
      )}
    </>
  )
}
