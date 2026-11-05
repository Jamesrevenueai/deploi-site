import Link from 'next/link'
import { requireRole } from '@/lib/auth'
import { staffOverview } from '@/lib/integrations/diagnostics'
import { STATUS_WORDS, type HealthStatus } from '@/lib/integrations/types'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'

export const metadata = { title: 'Integrations (staff)' }
export const dynamic = 'force-dynamic'

const FILTERS: (HealthStatus | 'all')[] = ['all', 'needs_reauth', 'error', 'connected']
const when = (iso: string | null) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—')

/** Staff: every organization's connections and their health, recent status changes, and the settings this deployment is missing. */
export default async function StaffIntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireRole('staff')
  const sp = await searchParams
  const filter = FILTERS.includes(sp.status as HealthStatus) ? (sp.status as HealthStatus | 'all') : 'all'
  const o = await staffOverview({ status: filter === 'all' ? null : filter })
  return (
    <>
      <PageHeader title="Integrations" eyebrow="Staff" sub="Connection health across organizations. Probes are read-only and run hourly (connection.health); a connection flips to “not working” after three failures in a row and is probed less often while it fails." />

      <h2 className="mb-3 text-[1.1rem]">Setup on this deployment</h2>
      <div className="table-wrap" data-testid="staff-setup">
        <table className="dg-table">
          <thead><tr><th>Integration</th><th>Missing environment variables</th></tr></thead>
          <tbody>
            {o.setup.map(s => (
              <tr key={s.key}><td className="ink">{s.name}</td><td>{s.missingEnv.length ? s.missingEnv.map(n => <code key={n} className="mr-2">{n}</code>) : <Badge tone="ok">configured</Badge>}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-8 mb-3 flex flex-wrap items-center gap-2 text-[14px]">
        <h2 className="mr-3 text-[1.1rem]">Connections</h2>
        {FILTERS.map(f => <Link key={f} href={f === 'all' ? '?' : `?status=${f}`} className={`badge ${f === filter ? '' : 'muted'}`}>{f === 'all' ? 'All' : STATUS_WORDS[f].label}</Link>)}
      </div>
      {o.rows.length === 0 ? <Empty title="No connections">Organizations&rsquo; connections appear here.</Empty> : (
        <div className="table-wrap" data-testid="staff-connections">
          <table className="dg-table">
            <thead><tr><th>Organization</th><th>Integration</th><th>Connection</th><th>Status</th><th>Failures</th><th>Last check</th><th>Last success</th><th>Next check</th><th>Last error</th></tr></thead>
            <tbody>
              {o.rows.flatMap(r => r.connections.map(c => (
                <tr key={`${r.key}:${c.id}`}>
                  <td className="ink">{r.orgName}</td>
                  <td>{r.name}</td>
                  <td>{c.label}{c.synthetic ? <span className="text-grey-h"> (synthetic)</span> : null}</td>
                  <td><Badge tone={STATUS_WORDS[c.status].tone}>{STATUS_WORDS[c.status].label}</Badge></td>
                  <td>{c.failures}</td>
                  <td>{when(c.lastCheckedAt)}</td>
                  <td>{when(c.lastSuccessAt)}</td>
                  <td>{when(c.nextCheckAt)}</td>
                  <td className="break-words">{c.lastError ?? '—'}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mt-8 mb-3 text-[1.1rem]">Recent status changes</h2>
      {o.transitions.length === 0 ? <Empty title="No changes">Status changes recorded by the health checks appear here.</Empty> : (
        <div className="table-wrap">
          <table className="dg-table">
            <thead><tr><th>When</th><th>Organization</th><th>Integration</th><th>Connection</th><th>Change</th><th>Result</th></tr></thead>
            <tbody>
              {o.transitions.map((t, n) => (
                <tr key={n}><td>{when(t.at)}</td><td className="ink">{t.orgName}</td><td>{t.key}</td><td>{t.label ?? '—'}</td><td>{t.previous ? STATUS_WORDS[t.previous].label : '—'} → {STATUS_WORDS[t.status].label}</td><td className="break-words">{t.message}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
