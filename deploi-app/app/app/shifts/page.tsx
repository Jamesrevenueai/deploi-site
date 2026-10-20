import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { initials } from '@/lib/dashboard/time'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'
import { MobileRows } from '@/components/dashboard/MobileRows'

export const metadata = { title: 'Shifts' }
export const dynamic = 'force-dynamic'

type Row = { id: string; cf: string; cl: string; af: string | null; al: string | null; service_code: string; starts_at: string; ends_at: string; status: string; open_since: string | null; filled_at: string | null }
const TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted' | 'none'> = { open: 'danger', scheduled: 'none', filled: 'ok', completed: 'muted', cancelled: 'muted' }

export default async function Shifts() {
  const session = await requireRole('client')
  const ip = await requestIp()
  const { rows, tz } = await withUser(session, async db => {
    const rows = await db.query<Row>(
      `select s.id, c.first_name as cf, c.last_name as cl, a.first_name as af, a.last_name as al, s.service_code, s.starts_at, s.ends_at, s.status, s.open_since, s.filled_at
       from shifts s join clients c on c.id = s.client_id left join aides a on a.id = s.aide_id
       where s.agency_id = $1 and s.ends_at >= now() - interval '7 days'
       order by (s.status = 'open') desc, s.starts_at asc limit 200`, [session.agencyId])
    await db.auditRead('shifts', session.agencyId, rows.map(r => r.id))
    const g = await db.one<{ timezone: string }>('select timezone from agencies where id = $1', [session.agencyId])
    return { rows, tz: g?.timezone ?? 'America/New_York' }
  }, { ip })
  const fmt = (s: string) => new Date(s).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const time = (s: string) => new Date(s).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
  const fillMin = (r: Row) => (r.open_since && r.filled_at ? Math.round((new Date(r.filled_at).getTime() - new Date(r.open_since).getTime()) / 60e3) : null)
  const openCount = rows.filter(r => r.status === 'open').length

  return (
    <>
      <PageHeader title="Shifts" sub={`${openCount} open. Open shifts first, then what is coming up. Clients are shown by initials.`} />
      {rows.length === 0 ? <Empty title="No shifts in this window" /> : (
        <>
          <div className="table-wrap hidden md:block">
            <table className="dg-table">
              <thead><tr><th>Starts</th><th>Ends</th><th>Client</th><th>Aide</th><th>Service</th><th>Status</th><th>Fill time</th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td className="ink whitespace-nowrap">{fmt(r.starts_at)}</td>
                    <td className="whitespace-nowrap">{time(r.ends_at)}</td>
                    <td>Client {initials(r.cf, r.cl)}</td>
                    <td>{r.af ? `${r.af} ${r.al?.[0] ?? ''}.` : <span className="text-danger">unassigned</span>}</td>
                    <td>{r.service_code}</td>
                    <td><Badge tone={TONE[r.status] ?? 'none'}>{r.status}</Badge></td>
                    <td>{fillMin(r) !== null ? `${fillMin(r)} min` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <MobileRows rows={rows.map(r => ({
            key: r.id, title: fmt(r.starts_at), badge: <Badge tone={TONE[r.status] ?? 'none'}>{r.status}</Badge>,
            lines: [`until ${time(r.ends_at)} · ${r.service_code}`, `Client ${initials(r.cf, r.cl)} · ${r.af ? `${r.af} ${r.al?.[0] ?? ''}.` : 'no aide yet'}`, ...(fillMin(r) !== null ? [`Filled in ${fillMin(r)} min`] : [])],
          }))} />
        </>
      )}
    </>
  )
}
