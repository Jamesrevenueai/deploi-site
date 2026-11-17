'use client'
/**
 * Business Insights: the business profile Deploi works from, the verified outcomes, and the time-saved
 * estimate. Estimates are labelled as estimates and show their formula; verified numbers count only cases a
 * fresh read confirmed.
 */
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'
import { storeFetch } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { Loading, Section } from '@/components/store/bits'
import { fmtAgo } from '@/components/store/format'
import { probe } from '@/components/cx/probe'
import { minutesInWords, type ControlRoomResponse, type WizardResponse } from '@/components/cx/types'
import { caseHref } from '@/lib/store/nav'
import { loadCases } from './data'
import { SUITE_LABEL, humanize, sourceAppLabel } from './caseView'
import { readDiscovery } from '@/components/discover/firstRun'
import { DISCOVER_API } from '@/components/discover/firstRun'

const safe = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null)

export function InsightsScreen() {
  const { data, loading } = useLoad(async () => {
    const [cr, wizard, completed, discover] = await Promise.all([
      safe(storeFetch<ControlRoomResponse>('/api/store/control-room')), safe(storeFetch<WizardResponse>('/api/store/onboarding').then(r => r.wizard)),
      safe(loadCases(['completed'], 100)), probe(DISCOVER_API),
    ])
    return { cr, wizard, completed, discovery: discover.availability === 'available' && discover.status === 200 ? readDiscovery(discover.json) : null }
  }, 'insights')
  const header = <PageHeader title="Business Insights" sub="What Deploi knows about your business, what it verified, and what it estimates. Estimates are always marked as estimates, with the formula." />
  if (loading && !data) return <>{header}<Loading label="Loading insights" rows={3} /></>
  if (!data) return header
  const { cr, wizard, completed } = data
  const outcomes = completed?.cases.filter(c => c.outcome) ?? []
  const byKind = Object.entries(outcomes.reduce<Record<string, number>>((m, c) => { m[c.kind] = (m[c.kind] ?? 0) + 1; return m }, {})).sort((a, b) => b[1] - a[1])
  return (
    <>
      {header}
      <Section id="profile" title="Business profile" sub="From your setup and your connected tools.">
        <div className="panel p-4 md:p-5">
          <dl className="kv">
            <dt>Business</dt><dd>{wizard?.business.name || cr?.org.name || '—'}</dd>
            <dt>Time zone</dt><dd>{wizard?.business.timezone || cr?.org.timezone || '—'}</dd>
            <dt>Products</dt><dd>{cr?.products.length ? cr.products.map(p => SUITE_LABEL[p as 'commerce' | 'office'] ?? humanize(p)).join(', ') : '—'}</dd>
            <dt>Store</dt><dd>{wizard?.store.connected ? `${wizard.store.name ?? 'Connected'}${wizard.store.synthetic ? ' (synthetic test store)' : ''}` : 'Not connected'}</dd>
            <dt>Agents</dt><dd>{cr ? `${cr.counts.total} store agent${cr.counts.total === 1 ? '' : 's'}, ${cr.library.switchedOn} library agent${cr.library.switchedOn === 1 ? '' : 's'} on` : '—'}</dd>
            {data.discovery && <><dt>Last discovery</dt><dd>{data.discovery.ranAt ? fmtAgo(data.discovery.ranAt) : 'Not run yet'}{data.discovery.sourcesRead.length ? ` · read ${data.discovery.sourcesRead.join(', ')}` : ''}</dd></>}
          </dl>
        </div>
      </Section>
      <Section id="verified" title="Verified outcomes" sub="Only cases a fresh read of the source confirmed. A sent message alone is never counted.">
        <div className="stat-grid mb-3">
          <div className="panel p-4"><div className="text-[13.5px] text-grey">Resolved, all time</div><div className="pt-2 text-[1.9rem] font-semibold text-ink tabular-nums">{completed ? completed.counts.completed : '—'}</div></div>
          <div className="panel p-4"><div className="text-[13.5px] text-grey">Resolved, last 30 days</div><div className="pt-2 text-[1.9rem] font-semibold text-ink tabular-nums">{completed ? completed.counts.resolved_30d : '—'}</div></div>
          <div className="panel p-4"><div className="text-[13.5px] text-grey">Store changes verified</div><div className="pt-2 text-[1.9rem] font-semibold text-ink tabular-nums">{cr ? cr.verification.verified ?? 0 : '—'}</div></div>
          <div className="panel p-4"><div className="text-[13.5px] text-grey">Open now</div><div className="pt-2 text-[1.9rem] font-semibold text-ink tabular-nums">{completed ? completed.counts.in_progress + completed.counts.attention + completed.counts.needs_approval : '—'}</div></div>
        </div>
        {byKind.length > 0 && <div className="mb-3 flex flex-wrap gap-2">{byKind.map(([k, n]) => <Badge key={k} tone="ok">{humanize(k)}: {n}</Badge>)}</div>}
        {outcomes.length === 0 ? <Empty title="No verified outcomes yet">They appear here as your team resolves work.</Empty> : (
          <ul className="flex flex-col gap-2" aria-label="Verified outcomes">
            {outcomes.slice(0, 10).map(c => <li key={c.id}><Link href={caseHref(c.ref)} className="panel block p-3 text-[14px]"><span className="text-grey-h">{c.ref} · {sourceAppLabel(c.source_app)} · {fmtAgo(c.outcome!.verifiedAt)}</span><div className="pt-1 text-ink">{c.outcome!.summary}</div></Link></li>)}
          </ul>
        )}
      </Section>
      <Section id="estimate" title={<>Time saved <span className="estimate-tag align-middle">Estimate</span></>} sub="Not measured: calculated from the work your agents did, with the formula below.">
        <div className="panel p-4 md:p-5" data-testid="estimate">
          <div className="text-[1.9rem] font-semibold text-ink">{cr ? minutesInWords(cr.weekly.minutes) : '—'} <span className="text-[14px] font-normal text-grey-h">this week</span></div>
          <p className="pt-2 text-[14px] text-grey"><strong className="text-ink">Formula:</strong> {cr ? cr.weekly.formula : 'not available right now'}.</p>
          <p className="pt-1 text-[13px] text-grey-h">The minutes per task are assumptions, not measurements of your business. The weekly summary shows the same estimate.</p>
        </div>
      </Section>
    </>
  )
}
