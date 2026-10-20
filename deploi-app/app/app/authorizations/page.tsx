import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { getMetrics } from '@/lib/dashboard/metrics'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'
import { MobileRows } from '@/components/dashboard/MobileRows'

export const metadata = { title: 'Authorizations' }
export const dynamic = 'force-dynamic'

function Bar({ pctLeft }: { pctLeft: number }) {
  const used = 100 - pctLeft
  return (
    <div className="h-2 w-full min-w-[120px] overflow-hidden rounded-full bg-[#1a1a1a]" aria-hidden="true">
      <div className={`h-full rounded-full ${pctLeft <= 15 ? 'bg-warn' : 'bg-white'}`} style={{ width: `${used}%` }} />
    </div>
  )
}

export default async function Authorizations() {
  const session = await requireRole('client')
  const ip = await requestIp()
  const m = await withUser(session, db => getMetrics(db, session.agencyId!), { ip })
  const rows = m.authorizations.rows
  const in30 = new Date(Date.now() + 30 * 86400e3).toISOString().slice(0, 10)

  return (
    <>
      <PageHeader title="Authorization units" sub={`${m.authorizations.lowCount} of ${m.authorizations.total} authorizations have 15% or fewer units left. ${m.authorizations.expiring30} expire within 30 days.`} />
      {rows.length === 0 ? <Empty title="No active authorizations" /> : (
        <>
          <div className="table-wrap hidden md:block">
            <table className="dg-table">
              <thead><tr><th>Client</th><th>Service</th><th>Used / authorized</th><th style={{ width: 220 }}>Usage</th><th>Left</th><th>Ends</th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td className="ink">Client {r.clientInitials}</td>
                    <td>{r.serviceCode}</td>
                    <td>{r.used.toLocaleString()} / {r.authorized.toLocaleString()}</td>
                    <td><Bar pctLeft={r.pctLeft} /></td>
                    <td><Badge tone={r.pctLeft <= 15 ? 'warn' : 'none'}>{r.pctLeft}%</Badge></td>
                    <td className={r.endsOn <= in30 ? 'text-warn' : ''}>{r.endsOn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <MobileRows rows={rows.map(r => ({
            key: r.id, title: `Client ${r.clientInitials} · ${r.serviceCode}`, badge: <Badge tone={r.pctLeft <= 15 ? 'warn' : 'none'}>{r.pctLeft}% left</Badge>,
            lines: [<Bar key="bar" pctLeft={r.pctLeft} />, `${r.used.toLocaleString()} of ${r.authorized.toLocaleString()} units used`, `Ends ${r.endsOn}${r.endsOn <= in30 ? ' · within 30 days' : ''}`],
          }))} />
        </>
      )}
    </>
  )
}
