import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { PageHeader } from '@/components/ui/PageHeader'
import { Select, Input } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'

export const metadata = { title: 'Audit log' }
export const dynamic = 'force-dynamic'

const PAGE = 50
type Row = { id: string; actor_email: string | null; org_name: string | null; table_name: string; row_id: string | null; action: string; at: string; ip: string | null }

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const ip = await requestIp()
  const page = Math.max(1, Number(sp.page ?? 1) || 1)
  const table = sp.table ?? ''
  const action = sp.action ?? ''
  const actor = sp.actor ?? ''

  const { rows, tables, total } = await withUser(session, async db => {
    const where: string[] = []
    const params: unknown[] = []
    if (table) { params.push(table); where.push(`a.table_name = $${params.length}`) }
    if (action) { params.push(action); where.push(`a.action = $${params.length}`) }
    if (actor) { params.push(`%${actor}%`); where.push(`p.email ilike $${params.length}`) }
    const w = where.length ? 'where ' + where.join(' and ') : ''
    const rows = await db.query<Row>(
      `select a.id, p.email as actor_email, g.name as org_name, a.table_name, a.row_id, a.action, a.at, a.ip
       from audit_events a left join profiles p on p.id = a.actor_id left join agencies g on g.id = a.agency_id
       ${w} order by a.at desc limit ${PAGE} offset ${(page - 1) * PAGE}`, params)
    const total = (await db.one<{ n: string }>(`select count(*)::text as n from audit_events a left join profiles p on p.id = a.actor_id ${w}`, params))?.n ?? '0'
    const tables = await db.query<{ table_name: string }>('select distinct table_name from audit_events order by 1')
    return { rows, tables: tables.map(t => t.table_name), total: Number(total) }
  }, { ip })

  const pages = Math.max(1, Math.ceil(total / PAGE))
  const qs = (p: number) => `?${new URLSearchParams({ ...(table && { table }), ...(action && { action }), ...(actor && { actor }), page: String(p) })}`

  return (
    <>
      <PageHeader title="Audit log" sub={`Every recorded read and write of organization data. ${total.toLocaleString()} events.`} />
      <form className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-[1fr_1fr_1fr_auto]" method="get">
        <Select name="table" defaultValue={table} aria-label="Table">
          <option value="">All tables</option>
          {tables.map(t => <option key={t} value={t}>{t}</option>)}
        </Select>
        <Select name="action" defaultValue={action} aria-label="Action">
          <option value="">All actions</option>
          {['read', 'insert', 'update', 'delete'].map(a => <option key={a} value={a}>{a}</option>)}
        </Select>
        <Input name="actor" defaultValue={actor} placeholder="Actor email" aria-label="Actor email" />
        <Button variant="ghost" size="sm" type="submit">Filter</Button>
      </form>

      {rows.length === 0 ? <Empty title="No events match" /> : (
        <>
          <div className="table-wrap hidden md:block">
            <table className="dg-table">
              <thead><tr><th>When</th><th>Actor</th><th>Organization</th><th>Table</th><th>Action</th><th>Row</th><th>IP</th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{new Date(r.at).toLocaleString('en-US', { timeZone: 'America/New_York' })}</td>
                    <td className="ink">{r.actor_email ?? <span className="text-grey-h">system</span>}</td>
                    <td>{r.org_name ?? '—'}</td>
                    <td>{r.table_name}</td>
                    <td><Badge tone={r.action === 'delete' ? 'danger' : r.action === 'read' ? 'muted' : 'none'}>{r.action}</Badge></td>
                    <td className="font-[inherit] text-[13px]">{r.row_id ? r.row_id.slice(0, 8) : '—'}</td>
                    <td>{r.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col gap-3 md:hidden">
            {rows.map(r => (
              <li key={r.id} className="rounded-2xl border border-line p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink font-medium">{r.table_name}</span>
                  <Badge tone={r.action === 'delete' ? 'danger' : r.action === 'read' ? 'muted' : 'none'}>{r.action}</Badge>
                </div>
                <div className="mt-1 text-[14px]">{r.actor_email ?? 'system'} · {r.org_name ?? 'no organization'}</div>
                <div className="text-[13px] text-grey-h">{new Date(r.at).toLocaleString('en-US', { timeZone: 'America/New_York' })}{r.ip ? ` · ${r.ip}` : ''}</div>
              </li>
            ))}
          </ul>
          <nav className="mt-5 flex items-center justify-between text-[14px]" aria-label="Pagination">
            <span className="text-grey-h">Page {page} of {pages}</span>
            <div className="flex gap-2">
              {page > 1 && <Button variant="ghost" size="xs" href={qs(page - 1)}>Newer</Button>}
              {page < pages && <Button variant="ghost" size="xs" href={qs(page + 1)}>Older</Button>}
            </div>
          </nav>
        </>
      )}
    </>
  )
}
