'use client'
/**
 * A competitor watcher's findings on its agent page: the monitored stores and their status, then the
 * findings, each marked Observed (seen on a public page, with the page and time) or Inference (Deploi's
 * reading of several observations), with the evidence it rests on. Never sales or revenue figures.
 */
import { useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { storeFetch, asApiError, type StoreApiError } from './api'
import { useLoad } from './useLoad'
import { ErrorState, Loading, Panel, Section } from './bits'
import { fmtTime } from './format'
import type { CompetitorCheckView, CompetitorFindingView, CompetitorSourceView } from '@/lib/competitors/queries'

type ViewResponse = { ok: true; sources: CompetitorSourceView[]; findings: CompetitorFindingView[]; checks: CompetitorCheckView[]; unseen: number }

const SOURCE_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  pending: { label: 'Not checked yet', tone: 'muted' },
  active: { label: 'Monitored', tone: 'ok' },
  blocked_robots: { label: 'Skipped: asks not to be read (robots.txt)', tone: 'warn' },
  unsupported: { label: 'Skipped: not supported', tone: 'warn' },
  unreachable: { label: 'Skipped: could not be reached', tone: 'warn' },
}
const CHECK_STATUS: Record<string, string> = { baseline: 'Starting point recorded', compared: 'Compared with the previous check', blocked_robots: 'Not read (robots.txt)', unsupported: 'Not supported', unreachable: 'Could not be reached' }
const KIND: Record<string, string> = {
  baseline: 'Starting point', new_product: 'New product', price_drop: 'Price down', price_rise: 'Price up', discount_started: 'Discount advertised', discount_ended: 'Discount ended',
  back_in_stock: 'Back in stock', sold_out: 'Sold out', no_longer_listed: 'No longer listed', bestseller_entered: 'Best-seller list', bestseller_moved: 'Best-seller list', bestseller_left: 'Best-seller list',
  featured: 'Featured', cross_store: 'On several stores', opportunity: 'Possible opportunity',
}
const value = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v))

export function CompetitorSections({ agentId, refreshKey }: { agentId: string; refreshKey: string }) {
  const { data, error, loading, reload } = useLoad(() => storeFetch<ViewResponse>(`/api/store/agents/${agentId}/competitors`), `competitors:${agentId}:${refreshKey}`)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<StoreApiError | null>(null)
  const act = async (key: string, body: { status: 'seen' | 'dismissed'; ids?: string[] }) => {
    setBusy(key); setErr(null)
    try { await storeFetch(`/api/store/agents/${agentId}/competitors`, { method: 'POST', body }) } catch (e) { setErr(asApiError(e)) } finally { setBusy(null); await reload() }
  }
  const sub = 'From the public pages of the stores you listed. Observed: seen on a page, with its address and the time. Inference: Deploi’s reading of several observations. Deploi never sees or estimates another store’s sales, revenue, units sold or conversion.'
  if (loading && !data) return <Section id="competitors" title="Competitor findings" sub={sub}><Loading label="Loading competitor findings" /></Section>
  if (error && !data) return <Section id="competitors" title="Competitor findings" sub={sub}><ErrorState error={error} onRetry={reload} /></Section>
  const d = data!
  const inferences = d.findings.filter(f => f.basis === 'inference')
  const observed = d.findings.filter(f => f.basis === 'observed' && f.kind !== 'baseline')
  const baselines = d.findings.filter(f => f.kind === 'baseline')

  return (
    <>
      <Section id="competitors" title="Competitor findings" sub={sub}
        actions={d.unseen > 0 ? <Button size="sm" variant="ghost" onClick={() => act('seen', { status: 'seen' })} disabled={busy !== null}>{busy === 'seen' ? 'Marking…' : `Mark ${d.unseen} as seen`}</Button> : undefined}>
        {err && <div className="mb-3"><ErrorState error={err} /></div>}
        <div className="mb-4 flex flex-wrap gap-2">
          <Badge tone={d.unseen ? 'warn' : 'muted'}>{d.unseen} new</Badge>
          <Badge tone="muted">{observed.length} observed change{observed.length === 1 ? '' : 's'}</Badge>
          <Badge tone="muted">{inferences.length} inference{inferences.length === 1 ? '' : 's'}</Badge>
        </div>

        <h3 className="mb-2 text-[1rem]">Stores</h3>
        <ul className="mb-6 grid grid-cols-1 gap-2 md:grid-cols-2" aria-label="Monitored stores">
          {d.sources.map(s => {
            const st = SOURCE_STATUS[s.status] ?? { label: s.status, tone: 'muted' as const }
            return (
              <li key={s.id} className="rounded-[14px] border border-line p-3 text-[14px]">
                <div className="flex flex-wrap items-center gap-2"><span className="break-all font-medium text-ink">{s.host}</span><Badge tone={st.tone}>{st.label}</Badge></div>
                <p className="pt-1 text-grey">{s.status === 'active' ? `${s.products} product${s.products === 1 ? '' : 's'} recorded · starting point ${s.baseline_at ? fmtTime(s.baseline_at) : '—'} · last checked ${s.last_checked_at ? fmtTime(s.last_checked_at) : '—'}`
                  : s.status_reason ?? 'Checked on the next run.'}</p>
              </li>
            )
          })}
        </ul>

        {d.findings.length === 0 ? <Empty title="No findings yet">The first check records a starting point for each store. Changes are reported from the second check on.</Empty> : (
          <div className="flex flex-col gap-6">
            {inferences.length > 0 && <Group title="Trends and possible opportunities (inference)" note="Deploi matched similar product names across stores. These are leads to research, not facts about anyone’s sales." items={inferences} busy={busy} onDismiss={f => act(`d:${f.id}`, { status: 'dismissed', ids: [f.id] })} />}
            {observed.length > 0 && <Group title="Changes observed on public pages" items={observed} busy={busy} onDismiss={f => act(`d:${f.id}`, { status: 'dismissed', ids: [f.id] })} />}
            {baselines.length > 0 && <Group title="Starting points" note="The first check of each store. Nothing on it is reported as new." items={baselines} busy={busy} />}
          </div>
        )}
      </Section>

      <Section id="competitor-checks" title="Competitor checks" sub="Every time a store was read or skipped: when, how many requests, and the exact pages read.">
        {d.checks.length === 0 ? <Empty title="Not checked yet">Press Run now, or wait for the schedule.</Empty> : (
          <ul className="flex flex-col gap-2">
            {d.checks.map(c => (
              <li key={c.id} className="rounded-[14px] border border-line p-3 text-[14px] text-grey">
                <div className="flex flex-wrap items-center gap-2"><span className="text-ink">{c.host}</span><Badge tone={c.status === 'baseline' || c.status === 'compared' ? 'ok' : 'warn'}>{CHECK_STATUS[c.status] ?? c.status}</Badge><span className="text-[13px] text-grey-h">{fmtTime(c.started_at)}</span></div>
                <p className="pt-1">{c.status_reason ?? `${c.products_seen} product${c.products_seen === 1 ? '' : 's'} read`} · {c.requests} request{c.requests === 1 ? '' : 's'}</p>
                {c.urls.length > 0 && <details className="pt-1"><summary className="cursor-pointer text-[13px] text-grey-h">Pages read</summary><ul className="mt-1 flex flex-col gap-0.5 text-[13px]">{c.urls.map(u => <li key={u} className="break-all">{u}</li>)}</ul></details>}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3"><Banner icon="shield">Deploi reads only public pages, follows each store&rsquo;s robots.txt, identifies itself as DeploiBot, and sends at most one request per second to a store. It never logs in, buys or contacts a competitor.</Banner></div>
      </Section>
    </>
  )
}

function Group({ title, note, items, busy, onDismiss }: { title: string; note?: string; items: CompetitorFindingView[]; busy: string | null; onDismiss?: (f: CompetitorFindingView) => void }) {
  return (
    <div>
      <h3 className="text-[1rem]">{title}</h3>
      {note && <p className="pt-1 text-[13px] text-grey-h">{note}</p>}
      <ul className="mt-2 flex flex-col gap-3">
        {items.map(f => (
          <li key={f.id}>
            <Panel>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={f.basis === 'observed' ? 'ok' : 'warn'}>{f.basis === 'observed' ? 'Observed fact' : 'Inference'}</Badge>
                <Badge tone="muted">{KIND[f.kind] ?? f.kind}</Badge>
                {f.status === 'new' && f.kind !== 'baseline' && <Badge tone="warn">New</Badge>}
              </div>
              <p className="pt-2 font-medium text-ink break-words">{f.title}</p>
              <p className="pt-1 text-[15px] text-grey">{f.summary}</p>
              {f.evidence.length > 0 && (
                <details className="mt-2" open={f.basis === 'inference'}>
                  <summary className="cursor-pointer text-[13px] text-grey-h">Evidence ({f.evidence.length})</summary>
                  <ul className="mt-2 flex flex-col gap-2">
                    {f.evidence.map((e, i) => (
                      <li key={i} className="rounded-[12px] border border-line p-2 text-[13px] text-grey">
                        <div className="flex flex-wrap gap-x-3">{e.store && <span className="text-ink">{e.store}</span>}<span>{e.what}</span><span className="text-grey-h">seen {fmtTime(e.observedAt)}</span></div>
                        {(e.before !== undefined || e.after !== undefined) && <div className="pt-0.5">{e.before !== undefined && <>Before{e.beforeObservedAt ? ` (${fmtTime(e.beforeObservedAt)})` : ''}: <span className="text-ink">{value(e.before)}</span> · </>}{e.before !== undefined ? 'After' : 'Shown'}: <span className="text-ink">{value(e.after)}</span></div>}
                        <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-ink underline">{e.url}</a>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {onDismiss && <div className="mt-2"><Button size="sm" variant="ghost" onClick={() => onDismiss(f)} disabled={busy !== null}>{busy === `d:${f.id}` ? 'Dismissing…' : 'Dismiss'}</Button></div>}
            </Panel>
          </li>
        ))}
      </ul>
    </div>
  )
}
