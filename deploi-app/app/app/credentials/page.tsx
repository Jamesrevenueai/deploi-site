import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { daysUntil } from '@/lib/dashboard/time'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'
import { MobileRows } from '@/components/dashboard/MobileRows'
import { ConsentToggle } from '@/components/actions/ConsentToggle'

export const metadata = { title: 'Credentials' }
export const dynamic = 'force-dynamic'

type Row = { aide_id: string; first_name: string; last_name: string; type: string; expires_on: string; sms_consent: boolean }

export default async function Credentials() {
  const session = await requireRole('client')
  const ip = await requestIp()
  const now = new Date()
  const rows = await withUser(session, async db => {
    const rows = await db.query<Row>(
      `select a.id as aide_id, a.first_name, a.last_name, a.sms_consent, c->>'type' as type, c->>'expires_on' as expires_on
       from aides a, jsonb_array_elements(a.credentials) c where a.agency_id = $1 and a.active
       order by c->>'expires_on' asc`, [session.agencyId])
    await db.auditRead('aides', session.agencyId, [...new Set(rows.map(r => r.aide_id))])
    return rows
  }, { ip })
  const withDays = rows.map(r => ({ ...r, days: daysUntil(r.expires_on + 'T23:59:59Z', now) ?? 0 }))
  const lapsing = withDays.filter(r => r.days <= 30).length
  const tone = (d: number): 'danger' | 'warn' | 'none' | 'muted' => (d < 0 ? 'danger' : d <= 7 ? 'danger' : d <= 30 ? 'warn' : 'none')
  const label = (d: number) => (d < 0 ? `lapsed ${-d} d ago` : d === 0 ? 'today' : `${d} d`)

  return (
    <>
      <PageHeader title="Credentials" sub={`${lapsing} credential${lapsing === 1 ? '' : 's'} lapse within 30 days. Soonest first.`} />
      {withDays.length === 0 ? <Empty title="No credentials on file" /> : (
        <>
          <div className="table-wrap hidden md:block">
            <table className="dg-table">
              <thead><tr><th>Aide</th><th>Credential</th><th>Expires</th><th>Days left</th><th>SMS</th></tr></thead>
              <tbody>
                {withDays.map((r, i) => (
                  <tr key={`${r.aide_id}-${r.type}-${i}`}>
                    <td className="ink">{r.first_name} {r.last_name}</td>
                    <td>{r.type}</td>
                    <td>{r.expires_on}</td>
                    <td><Badge tone={tone(r.days)}>{label(r.days)}</Badge></td>
                    <td><ConsentToggle kind="aide" id={r.aide_id} consent={r.sms_consent} back="/app/credentials" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <MobileRows rows={withDays.map((r, i) => ({
            key: `${r.aide_id}-${r.type}-${i}`, title: `${r.first_name} ${r.last_name} · ${r.type}`, badge: <Badge tone={tone(r.days)}>{label(r.days)}</Badge>,
            lines: [`Expires ${r.expires_on}`, <ConsentToggle key="c" kind="aide" id={r.aide_id} consent={r.sms_consent} back="/app/credentials" />],
          }))} />
        </>
      )}
    </>
  )
}
