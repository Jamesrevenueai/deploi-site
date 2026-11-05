'use client'
/**
 * Home: the Control Room with the work overview on top — work discovered, issues resolved (verified only),
 * in progress, pending approvals, agent status, connected apps, verified outcomes, the estimated time saved
 * (labelled Estimate, with its formula) and important insights. Every number comes from an API; when a source
 * cannot be read the tile shows "—" and says so.
 */
import Link from 'next/link'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'
import { Icon } from '@/components/ui/Icon'
import { ControlRoomScreen } from '@/components/cx/ControlRoom'
import { storeFetch } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { Section } from '@/components/store/bits'
import { fmtAgo } from '@/components/store/format'
import { minutesInWords, type ControlRoomResponse, type IntegrationsResponse } from '@/components/cx/types'
import { caseHref } from '@/lib/store/nav'
import { loadApprovals, loadCases } from './data'
import { homeInsights, homeMetrics, type CaseItem } from './caseView'

const safe = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null)

export function WorkOverview() {
  const { data } = useLoad(async () => {
    const [all, completed, approvals, cr, integrations] = await Promise.all([
      safe(loadCases(['all'], 50)), safe(loadCases(['completed'], 3)), safe(loadApprovals()),
      safe(storeFetch<ControlRoomResponse>('/api/store/control-room')), safe(storeFetch<IntegrationsResponse>('/api/store/control-room/integrations')),
    ])
    return { all, completed, approvals, cr, integrations }
  }, 'home-overview')
  if (!data) return <div className="stat-grid mt-2" aria-busy="true">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-[112px] animate-pulse rounded-[16px] border border-line bg-surface" />)}</div>
  const { all, completed, approvals, cr, integrations } = data
  const connectedApps = integrations ? integrations.integrations.filter(i => i.status === 'connected').length : null
  const metrics = homeMetrics({
    counts: all?.counts ?? null,
    approvals: approvals ? approvals.items.length + (all?.cases.filter(c => c.status === 'awaiting_approval' && !approvals.items.some(a => a.source === 'case' && a.id === c.id)).length ?? 0) : null,
    agents: cr ? { running: cr.agents.filter(a => a.status === 'active').length + cr.library.switchedOn, total: cr.counts.total + cr.library.switchedOn, needsAttention: cr.counts.needsAttention + cr.counts.draft } : null,
    connectedApps,
    weekly: cr ? cr.weekly : null,
  })
  const insights = homeInsights({ counts: all?.counts ?? null, approvals: metrics.find(m => m.key === 'approvals')?.value ?? null, cases: all?.cases ?? [], connectedApps })
  const outcomes: CaseItem[] = completed?.cases.filter(c => c.outcome) ?? []
  const firstRun = all && all.counts.total === 0
  return (
    <>
      {firstRun && (
        <div className="panel mb-4 flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between md:p-5" data-testid="first-run-cta">
          <div><div className="font-semibold text-ink">See what your AI team can handle</div><p className="text-[14px] text-grey">Deploi reads your connected tools and lists the work it found, with the team it recommends.</p></div>
          <Link href="/store/welcome" className="btn sm">See what Deploi found<Icon name="arrow-right" size={15} /></Link>
        </div>
      )}
      <div className="stat-grid" data-testid="home-tiles">
        {metrics.map(m => (
          <Link key={m.key} href={m.href} className="panel block p-4 transition-colors hover:border-[var(--c-accent-line)]" data-metric={m.key}>
            <div className="flex items-center justify-between gap-2"><span className="text-[13.5px] font-medium text-grey">{m.label}</span>{m.estimate && <span className="estimate-tag">Estimate</span>}</div>
            <div className="pt-2 text-[1.9rem] font-semibold leading-none tracking-tight text-ink tabular-nums">
              {m.value === null ? <span className="text-grey-h">—</span> : m.key === 'time' ? minutesInWords(m.value) : m.key === 'approvals' ? <span data-testid="approvals-count">{m.value}</span> : m.value}
            </div>
            <div className="pt-2 text-[12.5px] text-grey-h">{m.value === null ? 'Could not be read right now' : m.sub}</div>
          </Link>
        ))}
        <Link href="/store/completed" className="panel block p-4" data-metric="outcomes">
          <span className="text-[13.5px] font-medium text-grey">Verified outcomes</span>
          <div className="pt-2 text-[1.9rem] font-semibold leading-none text-ink tabular-nums">{all ? all.counts.resolved_30d : <span className="text-grey-h">—</span>}</div>
          <div className="pt-2 text-[12.5px] text-grey-h">Confirmed in the last 30 days</div>
        </Link>
      </div>
      {cr && <p className="pt-2 text-[12.5px] text-grey-h">Time saved is an estimate: {cr.weekly.formula}.</p>}

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <Section id="insights" title="Important insights" sub="From your cases and approvals, as they stand now.">
          {insights.length === 0 ? <Empty title="Nothing needs you">No blocked work, no decisions waiting.</Empty> : (
            <ul className="flex flex-col gap-2" aria-label="Insights">
              {insights.map((x, i) => <li key={i}><Link href={x.href} className="panel flex items-start gap-3 p-3 text-[14px]"><Badge tone={x.tone}>{x.tone === 'danger' ? 'Attention' : x.tone === 'warn' ? 'For you' : 'Note'}</Badge><span className="min-w-0 break-words text-ink">{x.text}</span></Link></li>)}
            </ul>
          )}
        </Section>
        <Section id="outcomes" title="Latest verified outcomes" actions={<Link href="/store/completed" className="btn ghost xs">Completed Work<Icon name="arrow-right" size={14} /></Link>}>
          {outcomes.length === 0 ? <Empty title="No verified outcomes yet">Resolved work appears here once a fresh read confirms it.</Empty> : (
            <ul className="flex flex-col gap-2" aria-label="Verified outcomes">
              {outcomes.map(c => <li key={c.id}><Link href={caseHref(c.ref)} className="panel block p-3 text-[14px]"><div className="flex flex-wrap items-center gap-2"><Badge tone="ok">Verified</Badge><span className="text-grey-h">{c.ref} · {fmtAgo(c.outcome!.verifiedAt)}</span></div><div className="pt-1 break-words text-ink">{c.outcome!.summary}</div></Link></li>)}
            </ul>
          )}
        </Section>
      </div>
    </>
  )
}

export function HomeScreen() {
  return <ControlRoomScreen title="Home" sub="Your business has unfinished work. Deploi finds it, handles it, and shows you what got done." top={<WorkOverview />} tiles={false} />
}
