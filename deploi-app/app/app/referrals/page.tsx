import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'
import { MobileRows } from '@/components/dashboard/MobileRows'

export const metadata = { title: 'Referrals' }
export const dynamic = 'force-dynamic'

type Row = { id: string; source_name: string | null; source_org: string | null; source_channel: string; county: string | null; service: string | null; received_at: string; first_response_at: string | null; responded_by: string | null; status: string }
const TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted' | 'none'> = { new: 'warn', responded: 'none', intake: 'none', active: 'ok', declined: 'muted', lost: 'danger' }

function minutesBetween(a: string, b: string | null) {
  if (!b) return null
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60e3)
}

export default async function Referrals() {
  const session = await requireRole('client')
  const ip = await requestIp()
  const { rows, tz } = await withUser(session, async db => {
    const rows = await db.query<Row>(
      `select id, source_name, source_org, source_channel, county, service, received_at, first_response_at, responded_by, status
       from referrals where agency_id = $1 order by (first_response_at is null) desc, received_at desc limit 200`, [session.agencyId])
    await db.auditRead('referrals', session.agencyId, rows.map(r => r.id))
    const g = await db.one<{ timezone: string }>('select timezone from agencies where id = $1', [session.agencyId])
    return { rows, tz: g?.timezone ?? 'America/New_York' }
  }, { ip })
  const fmt = (s: string | null) => (s ? new Date(s).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')

  return (
    <>
      <PageHeader title="Referrals" sub="Every referral, who sent it, and how fast it got a first response." />
      {rows.length === 0 ? <Empty title="No referrals yet" /> : (
        <>
          <div className="table-wrap hidden md:block">
            <table className="dg-table">
              <thead><tr><th>Received</th><th>From</th><th>Channel</th><th>County · service</th><th>First response</th><th>Minutes</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map(r => {
                  const mins = minutesBetween(r.received_at, r.first_response_at)
                  return (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap">{fmt(r.received_at)}</td>
                      <td className="ink">{r.source_name ?? '—'}<div className="text-[13px] text-grey-h">{r.source_org ?? ''}</div></td>
                      <td>{r.source_channel}</td>
                      <td>{r.county ?? '—'} · {r.service ?? '—'}</td>
                      <td className="whitespace-nowrap">{fmt(r.first_response_at)}{r.responded_by ? <div className="text-[13px] text-grey-h">by {r.responded_by}</div> : null}</td>
                      <td className={mins === null ? 'text-warn' : mins > 60 ? 'text-warn' : ''}>{mins === null ? 'waiting' : mins}</td>
                      <td><Badge tone={TONE[r.status] ?? 'none'}>{r.status}</Badge></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <MobileRows rows={rows.map(r => {
            const mins = minutesBetween(r.received_at, r.first_response_at)
            return {
              key: r.id, title: `${r.source_name ?? 'Unknown'}${r.source_org ? ` · ${r.source_org}` : ''}`, badge: <Badge tone={TONE[r.status] ?? 'none'}>{r.status}</Badge>,
              lines: [`Received ${fmt(r.received_at)} via ${r.source_channel}`, `${r.county ?? '—'} · ${r.service ?? '—'}`, mins === null ? 'No first response yet' : `First response in ${mins} min${r.responded_by ? ` by ${r.responded_by}` : ''}`],
            }
          })} />
        </>
      )}
    </>
  )
}
