import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/Badge'
import type { ClientSections } from '@/lib/dashboard/sections'
import { STALE_AFTER_DAYS } from '@/lib/dashboard/sections'

const SERVICE_TONE: Record<string, 'ok' | 'warn' | 'muted' | 'none'> = { production_verified: 'ok', supervised_pilot: 'warn', demonstration: 'muted', planned: 'muted' }

export function Section({ id, title, sub, children }: { id: string; title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-8 fade-up" aria-labelledby={id}>
      <h2 id={id} className="mb-1">{title}</h2>
      {sub && <p className="mb-3 text-[15px] text-grey max-w-[70ch]">{sub}</p>}
      <div className="rounded-[20px] border border-line p-5">{children}</div>
    </section>
  )
}

const fmtDate = (iso: string | null, tz: string) => (iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }) : '—')
const fmtWhen = (iso: string | null, tz: string) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')

export function ActiveServices({ s }: { s: ClientSections['services'] }) {
  return (
    <Section id="services" title="Active services" sub="What Deploi currently runs for your agency, with its availability status.">
      {s.rows.length === 0 ? <p className="text-grey">{s.note ?? 'No active services recorded yet.'}</p> : (
        <ul className="flex flex-col divide-y divide-line">
          {s.rows.map(r => (
            <li key={r.key + r.status} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
              <span className="text-ink font-medium">{r.name}</span>
              <span className="flex items-center gap-2"><Badge tone="none">{r.status}</Badge><Badge tone={SERVICE_TONE[r.availability] ?? 'muted'}>{r.availabilityLabel}</Badge></span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

export function FreshnessSection({ f, tz }: { f: ClientSections['freshness']; tz: string }) {
  return (
    <Section id="freshness" title="Reporting period and data freshness" sub={`Numbers cover the last 30 days. An import counts as stale after ${STALE_AFTER_DAYS} days.`}>
      {f.imports.length === 0 ? <p className="text-grey">No committed import yet. <Badge tone="warn">stale</Badge></p> : (
        <ul className="flex flex-col divide-y divide-line">
          {f.imports.map(i => (
            <li key={i.source + i.kind} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
              <span><span className="text-ink font-medium">{i.kind}</span> <span className="text-grey">· last import {fmtWhen(i.lastAt, tz)}{i.ageDays !== null ? ` (${i.ageDays} d ago)` : ''}</span></span>
              <Badge tone={i.stale ? 'warn' : 'ok'}>{i.stale ? 'stale' : 'fresh'}</Badge>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[14px] text-grey-h">
        Last worker run: {f.lastWorkerRun ? `${f.lastWorkerRun.worker.replace(/_/g, ' ')} · ${fmtWhen(f.lastWorkerRun.finishedAt, tz)}` : 'none recorded yet'}.
        {f.importsNote ? ` ${f.importsNote}` : ''}
      </p>
    </Section>
  )
}

export function ActivitySection({ a }: { a: ClientSections['activity'] }) {
  return (
    <Section id="activity" title="Verified activity" sub={`Messages that were actually delivered in the last ${a.windowDays} days. Simulated sends and drafts are never counted.`}>
      {!a.available ? <p className="text-grey">{a.note}</p> : a.delivered === 0 ? <p className="text-grey">No verified deliveries in this period.</p> : (
        <>
          <div className="tile-value">{a.delivered}</div>
          <ul className="mt-2 flex flex-wrap gap-2">{a.byWorker.map(w => <li key={w.worker} className="badge muted">{w.worker.replace(/_/g, ' ')} · {w.n}</li>)}</ul>
        </>
      )}
    </Section>
  )
}

export function OutcomesSection({ o }: { o: ClientSections['outcomes'] }) {
  const cells = [
    { label: 'Shifts confirmed filled', value: o.shiftsFilled },
    { label: 'Referrals answered', value: o.referralsAnswered },
    { label: 'EVV exceptions corrected', value: o.exceptionsCorrected },
  ]
  return (
    <Section id="outcomes" title="Verified outcomes" sub={`Last ${o.windowDays} days. Drafts, outreach and detection are never counted as outcomes.`}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {cells.map(c => <div key={c.label}><div className="tile-label">{c.label}</div><div className="tile-value">{c.value}</div></div>)}
      </div>
      <details className="mt-4 text-[14px] text-grey">
        <summary className="cursor-pointer text-grey-h">What counts</summary>
        <ul className="mt-2 list-disc pl-5">{o.whatCounts.map(w => <li key={w}>{w}</li>)}</ul>
      </details>
    </Section>
  )
}

export function PilotSection({ p, tz }: { p: ClientSections['pilot']; tz: string }) {
  return (
    <Section id="pilot" title="Pilot progress" sub="Dates and the primary metric, baseline against latest.">
      {!p.available || p.note ? <p className="text-grey">{p.note}</p> : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div><div className="tile-label">Dates</div><div className="text-ink">{fmtDate(p.startsOn, tz)} → {fmtDate(p.endsOn, tz)}</div>{p.status && <Badge tone="none">{p.status}</Badge>}</div>
          <div>
            <div className="tile-label">{p.metricLabel ?? 'Primary metric'}</div>
            <div className="text-ink">baseline {p.baseline ?? '—'} · latest {p.latest ?? '—'}</div>
            {p.decision && <div className="mt-1 text-[14px] text-grey">Decision: {p.decision}</div>}
          </div>
        </div>
      )}
    </Section>
  )
}

export function LimitationsSection({ l }: { l: ClientSections['limitations'] }) {
  return (
    <Section id="limitations" title="Relevant service limitations" sub="What each active service does not do, and its volume limits.">
      <p className="text-ink">{l.csvNote}</p>
      {l.rows.length === 0 ? <p className="mt-2 text-grey">Limitations for your services appear here once a service is active.</p> : (
        <ul className="mt-4 flex flex-col gap-4">
          {l.rows.map(r => (
            <li key={r.service}>
              <div className="text-ink font-medium">{r.service}</div>
              <div className="mt-1 text-[14px] text-grey-h">Not included</div>
              <ul className="list-disc pl-5 text-[14px] text-grey">{r.exclusions.map(e => <li key={e}>{e}</li>)}</ul>
              <div className="mt-1 text-[14px] text-grey-h">Volume</div>
              <ul className="list-disc pl-5 text-[14px] text-grey">{r.volumeLimits.map(e => <li key={e}>{e}</li>)}</ul>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
