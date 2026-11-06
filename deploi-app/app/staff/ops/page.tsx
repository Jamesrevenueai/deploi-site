import Link from 'next/link'
import { requireRole } from '@/lib/auth'
import { admin } from '@/lib/db'
import { listAlerts } from '@/lib/ops/alerts'
import { queryOpsLogs, type OpsLevel } from '@/lib/ops/logs'
import { findCaseByRef, globalSwitches, listOrgs, orgOverview, queueOverview } from '@/lib/ops/staff'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Field'
import { Empty } from '@/components/ui/Empty'
import { acknowledgeAlertAction, cancelJobAction, clearOrgStopAction, requeueJobAction, stopOrgAction } from './actions'

export const metadata = { title: 'Operations' }
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const when = (s: string | null | undefined) => (s ? new Date(s).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—')
const LEVELS: OpsLevel[] = ['info', 'warn', 'error']

export default async function OpsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireRole('staff')
  const sp = await searchParams
  const orgId = UUID.test(sp.org ?? '') ? sp.org! : null
  const caseRef = (sp.case ?? '').trim()
  const level = LEVELS.includes(sp.level as OpsLevel) ? sp.level as OpsLevel : undefined
  const logFilter = { orgId: orgId ?? undefined, caseRef: sp.logcase?.trim() || undefined, jobId: UUID.test(sp.job ?? '') ? sp.job : undefined, correlationId: sp.corr?.trim() || undefined, level, limit: 50 }
  const here = `/staff/ops?${new URLSearchParams(Object.entries(sp).filter(([k, v]) => k !== 'notice' && v) as [string, string][]).toString()}`
  const sw = globalSwitches()
  const data = await admin(async db => ({
    queue: await queueOverview(db), alerts: await listAlerts(db, { status: 'live', limit: 50 }), orgs: await listOrgs(db, sp.q ?? ''),
    org: orgId ? await orgOverview(db, orgId) : null, found: caseRef ? await findCaseByRef(db, caseRef) : null, logs: await queryOpsLogs(db, logFilter),
  }))
  const q = data.queue.stats

  return (
    <>
      <PageHeader eyebrow="Staff" title="Operations" sub="Queue, alerts, organizations, cases and operational logs. Every action here is audited. Staff can stop work; only the customer approves, grants or resumes." />
      {sp.notice && <div className="mb-4"><Banner icon="check">{sp.notice}</Banner></div>}

      <section className="mb-8 flex flex-col gap-2" aria-label="Global switches">
        <h2>Global switches</h2>
        <Banner tone={sw.jobsPaused ? 'warn' : 'info'} icon="bolt"><strong>JOBS_PAUSED is {sw.jobsPaused ? 'on' : 'off'}.</strong> {sw.instructions.jobsPaused}</Banner>
        <Banner tone={sw.liveWrites === 'off' ? 'warn' : 'info'} icon="shield"><strong>LIVE_WRITES is {sw.liveWrites}.</strong> {sw.instructions.liveWrites}</Banner>
      </section>

      <section className="mb-8" aria-label="Queue">
        <h2 className="mb-3">Queue</h2>
        <p className="mb-3 text-[14px]">Due <strong>{q.due}</strong> · running <strong>{q.running}</strong> · queued <strong>{q.queued}</strong> · dead <strong data-testid="dead-count">{q.dead}</strong> · expired leases {q.expiredLeases} · oldest due {Math.round(q.oldestDueAgeSec / 60)} min</p>
        {data.queue.dead.length === 0 ? <Empty title="No dead or failed jobs" /> : (
          <div className="table-wrap">
            <table className="dg-table">
              <thead><tr><th>Job</th><th>Organization</th><th>Status</th><th>Attempts</th><th>Last error</th><th>Finished</th><th /></tr></thead>
              <tbody>
                {data.queue.dead.map(j => (
                  <tr key={j.id}>
                    <td className="ink"><Link href={`/staff/ops?job=${j.id}`}>{j.kind}</Link><div className="text-[12px] text-grey-h">{j.id.slice(0, 8)}</div></td>
                    <td>{j.org_id ? <Link href={`/staff/ops?org=${j.org_id}`}>{j.org_name ?? j.org_id.slice(0, 8)}</Link> : 'platform'}</td>
                    <td><Badge tone={j.status === 'dead' ? 'danger' : 'warn'}>{j.status}</Badge></td>
                    <td>{j.attempts}/{j.max_attempts}</td>
                    <td className="max-w-[32ch] text-[13px]">{j.last_error ?? '—'}</td>
                    <td className="whitespace-nowrap">{when(j.finished_at)}</td>
                    <td className="whitespace-nowrap">
                      <form action={requeueJobAction} className="inline"><input type="hidden" name="id" value={j.id} /><input type="hidden" name="back" value={here} /><Button variant="ghost" size="xs" type="submit">Requeue</Button></form>{' '}
                      <form action={cancelJobAction} className="inline"><input type="hidden" name="id" value={j.id} /><input type="hidden" name="back" value={here} /><Button variant="ghost" size="xs" type="submit">Cancel</Button></form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mb-8" aria-label="Alerts">
        <h2 className="mb-3">Alerts</h2>
        {data.alerts.length === 0 ? <Empty title="No live alerts">Rules run every 10 minutes; alerts clear themselves when the condition does.</Empty> : (
          <ul className="flex flex-col gap-2">
            {data.alerts.map(a => (
              <li key={a.id} className="rounded-2xl border border-line p-4 flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2"><Badge tone={a.severity === 'page' ? 'danger' : 'warn'}>{a.severity}</Badge><Badge tone="muted">{a.rule}</Badge>{a.status === 'acknowledged' && <Badge tone="info">acknowledged by {a.acknowledged_by}</Badge>}</div>
                  <div className="mt-1 text-ink">{a.title}</div>
                  <div className="text-[13px] text-grey-h">First seen {when(a.first_seen_at)} · last {when(a.last_seen_at)} · {a.occurrences}× {a.org_id && <>· <Link href={`/staff/ops?org=${a.org_id}`}>organization</Link></>}</div>
                </div>
                {a.status === 'open' && <form action={acknowledgeAlertAction}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="back" value={here} /><Button variant="ghost" size="xs" type="submit">Acknowledge</Button></form>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-8" aria-label="Case search">
        <h2 className="mb-3">Find a case</h2>
        <form method="get" className="mb-3 flex gap-2"><Input name="case" defaultValue={caseRef} placeholder="DC-000123" aria-label="Case reference" /><Button variant="ghost" size="sm" type="submit">Find</Button></form>
        {caseRef && !data.found && <Empty title={`No case ${caseRef}`} />}
        {data.found && (
          <div className="rounded-2xl border border-line p-4" data-testid="case-result">
            <div className="flex flex-wrap items-center gap-2"><strong>{data.found.case.ref}</strong><Badge>{data.found.case.status}</Badge><Badge tone="muted">{data.found.case.kind}</Badge></div>
            <div className="mt-1">{data.found.case.title}</div>
            <div className="text-[13px] text-grey-h"><Link href={`/staff/ops?org=${data.found.case.org_id}`}>{data.found.orgName ?? 'organization'}</Link> · opened {when(data.found.case.opened_at)} · next check {when(data.found.case.next_check_at)} · deadline {when(data.found.case.deadline_at)}</div>
            <ul className="mt-3 flex flex-col gap-1 text-[13px]">{data.found.logs.slice(0, 40).map((l, k) => <li key={k}><span className="text-grey-h">{when(l.at)}</span> <Badge tone={l.level === 'error' ? 'danger' : l.level === 'warn' ? 'warn' : 'muted'}>{l.event}</Badge> {l.summary}</li>)}</ul>
          </div>
        )}
      </section>

      <section className="mb-8" aria-label="Organizations">
        <h2 className="mb-3">Organizations</h2>
        <form method="get" className="mb-3 flex gap-2"><Input name="q" defaultValue={sp.q ?? ''} placeholder="Name or id" aria-label="Organization" /><Button variant="ghost" size="sm" type="submit">Search</Button></form>
        <ul className="mb-4 flex flex-wrap gap-2">{data.orgs.map(o => <li key={o.id}><Link className={`badge ${o.id === orgId ? 'info' : 'muted'}`} href={`/staff/ops?org=${o.id}`}>{o.name} · {o.open_cases} open{o.attention ? ` · ${o.attention} need attention` : ''}{o.agents_stopped ? ' · stopped' : ''}</Link></li>)}</ul>
        {data.org && (
          <div className="rounded-2xl border border-line p-4 flex flex-col gap-3" data-testid="org-view">
            <div className="flex flex-wrap items-center gap-2"><strong>{data.org.org.name}</strong>{data.org.control.agents_stopped ? <Badge tone="danger">all agents stopped</Badge> : <Badge tone="ok">running</Badge>}</div>
            {data.org.control.agents_stopped && <div className="text-[13px]">Stopped by {data.org.control.stopped_by} at {when(data.org.control.stopped_at)}: {data.org.control.stop_reason}</div>}
            <div className="flex flex-wrap gap-3">
              {!data.org.control.agents_stopped ? (
                <form action={stopOrgAction} className="flex gap-2"><input type="hidden" name="org" value={data.org.org.id} /><input type="hidden" name="back" value={here} /><Input name="reason" placeholder="Why (the customer sees it)" aria-label="Reason" required /><Button variant="danger" size="sm" type="submit">Stop all agents</Button></form>
              ) : (
                <form action={clearOrgStopAction} className="flex gap-2"><input type="hidden" name="org" value={data.org.org.id} /><input type="hidden" name="back" value={here} /><Button variant="ghost" size="sm" type="submit">Turn the stop off (agents stay paused)</Button></form>
              )}
            </div>
            <div className="text-[14px]"><strong>Cases:</strong> {Object.entries(data.org.casesByStatus).map(([s, n]) => `${s} ${n}`).join(' · ') || 'none'}</div>
            <div className="text-[14px]"><strong>Store agents:</strong> {data.org.agents.map(a => `${a.name} (${a.status})`).join(', ') || 'none'} · <strong>Office agents:</strong> {data.org.officeAgents.map(a => `${a.name} (${a.status})`).join(', ') || 'none'} · <strong>Library:</strong> {data.org.library.filter(l => l.enabled).map(l => l.agent_key).join(', ') || 'none on'}</div>
            <div className="text-[14px]"><strong>Recent failures (7 days):</strong>
              <ul className="mt-1 text-[13px]">{data.org.recentFailures.map(f => <li key={f.ref}><Link href={`/staff/ops?case=${f.ref}`}>{f.ref}</Link> {f.kind} <Badge tone="warn">{f.status}</Badge> {f.status_reason}</li>)}{data.org.failedJobs.map(j => <li key={j.id}><Link href={`/staff/ops?job=${j.id}`}>{j.kind}</Link> <Badge tone="danger">{j.status}</Badge> {j.last_error}</li>)}</ul>
              {!data.org.recentFailures.length && !data.org.failedJobs.length && <span className="text-[13px]"> none</span>}
            </div>
          </div>
        )}
      </section>

      <section aria-label="Operational logs">
        <h2 className="mb-3">Operational logs</h2>
        <form method="get" className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-[1fr_1fr_1fr_auto_auto]">
          {orgId && <input type="hidden" name="org" value={orgId} />}
          <Input name="logcase" defaultValue={sp.logcase ?? ''} placeholder="Case ref" aria-label="Case ref" />
          <Input name="job" defaultValue={sp.job ?? ''} placeholder="Job id" aria-label="Job id" />
          <Input name="corr" defaultValue={sp.corr ?? ''} placeholder="Correlation id" aria-label="Correlation id" />
          <Select name="level" defaultValue={level ?? ''} aria-label="Level"><option value="">All levels</option>{LEVELS.map(l => <option key={l} value={l}>{l}</option>)}</Select>
          <Button variant="ghost" size="sm" type="submit">Filter</Button>
        </form>
        {data.logs.length === 0 ? <Empty title="No log rows match" /> : (
          <div className="table-wrap">
            <table className="dg-table">
              <thead><tr><th>When</th><th>Level</th><th>Event</th><th>Correlation</th><th>Summary</th></tr></thead>
              <tbody>{data.logs.map((l, k) => (
                <tr key={k}>
                  <td className="whitespace-nowrap">{when(l.at)}</td>
                  <td><Badge tone={l.level === 'error' ? 'danger' : l.level === 'warn' ? 'warn' : 'muted'}>{l.level}</Badge></td>
                  <td>{l.event}</td>
                  <td className="text-[12px]">{[l.case_ref, l.job_id?.slice(0, 8), l.org_id?.slice(0, 8)].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="text-[13px] max-w-[60ch]">{l.summary}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
