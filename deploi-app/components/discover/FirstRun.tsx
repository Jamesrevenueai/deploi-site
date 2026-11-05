'use client'
/**
 * First run: "We found work your AI team can handle." Real findings from Business Discovery, the team Deploi
 * recommends for them, and "Set up my team" (POST /api/store/discover/team). When discovery is not deployed,
 * has not run, or nothing is connected, the screen says exactly that; it never shows example findings.
 * Usable on its own page (/store/welcome) or rendered by the discovery page.
 */
import { useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Icon } from '@/components/ui/Icon'
import { storeFetch, asApiError, type StoreApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading } from '@/components/store/bits'
import { probe } from '@/components/cx/probe'
import { caseHref } from '@/lib/store/nav'
import { readDiscovery, type Discovery } from './firstRun'

export const DISCOVER_API = '/api/store/discover'
export const DISCOVER_TEAM_API = '/api/store/discover/team'

type Load = { available: boolean; discovery: Discovery | null; connected: number | null }

export function FirstRun({ heading = 'h1' }: { heading?: 'h1' | 'h2' }) {
  const { data, error, loading, reload } = useLoad<Load>(async () => {
    const [p, integ] = await Promise.all([probe(DISCOVER_API), storeFetch<{ integrations: { status: string }[] }>('/api/store/control-room/integrations').catch(() => null)])
    const connected = integ ? integ.integrations.filter(i => i.status === 'connected').length : null
    if (p.availability === 'missing') return { available: false, discovery: null, connected }
    return { available: true, discovery: p.status === 200 ? readDiscovery(p.json) : null, connected }
  }, 'first-run')
  const [busy, setBusy] = useState<'scan' | 'team' | null>(null)
  const [err, setErr] = useState<StoreApiError | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const H = heading
  const title = <H className="text-[1.75rem] md:text-[2.1rem]">We found work your AI team can handle.</H>

  async function run() {
    setBusy('scan'); setErr(null)
    try { await storeFetch(DISCOVER_API, { method: 'POST', body: {} }); await reload() } catch (e) { setErr(asApiError(e)) } finally { setBusy(null) }
  }
  async function setUp(templates: string[]) {
    setBusy('team'); setErr(null)
    try {
      const r = await storeFetch<{ created?: unknown[]; agents?: unknown[] }>(DISCOVER_TEAM_API, { method: 'POST', body: { templates } })
      const n = (Array.isArray(r.created) ? r.created.length : Array.isArray(r.agents) ? r.agents.length : templates.length)
      setDone(`Your team is set up: ${n} agent${n === 1 ? '' : 's'} at drafts only. Each one acts only after you grant it.`)
    } catch (e) { setErr(asApiError(e)) } finally { setBusy(null) }
  }

  const shell = (body: React.ReactNode) => (
    <section className="fade-up" aria-labelledby="first-run-h" data-testid="first-run">
      <div className="panel overflow-hidden">
        <div className="border-b border-line bg-accent-soft p-5 md:p-8">
          <div className="eyebrow pb-2">Deploi discovery</div>
          <div id="first-run-h">{title}</div>
          <p className="max-w-[60ch] pt-2 text-[15px] text-grey">Deploi read what you connected and lists only problems it actually found, with the agents that would handle them. Nothing is done until you set up the team and grant each agent.</p>
        </div>
        <div className="p-5 md:p-8">{body}</div>
      </div>
    </section>
  )

  if (loading && !data) return shell(<Loading label="Reading what Deploi found" rows={2} />)
  if (error && !data) return shell(<ErrorState error={error} onRetry={reload} />)
  if (!data) return null
  if (!data.available) {
    return shell(
      <div data-state="unavailable">
        <Empty title="Discovery is not switched on here yet">When it is, this page lists the work Deploi finds in your connected tools. Meanwhile your current work is in <Link href="/store/work" className="link">Work in Progress</Link>.</Empty>
      </div>,
    )
  }
  const d = data.discovery
  if (data.connected === 0 || d?.state === 'nothing_connected') {
    return shell(
      <div data-state="nothing-connected" className="flex flex-col gap-3">
        <Empty title="Connect a tool first">Deploi can only look at tools you connect: your store, email, CRM or calendar.</Empty>
        <div><Button href="/store/integrations" size="sm">Connect your tools<Icon name="arrow-right" size={15} /></Button></div>
      </div>,
    )
  }
  if (!d || d.state === 'not_run' || d.state === 'running') {
    return shell(
      <div data-state={d?.state ?? 'not-run'} className="flex flex-col gap-3">
        <p className="text-[15px] text-grey">{d?.state === 'running' ? 'Deploi is reading your connected tools now. This page updates when it finishes.' : 'Deploi has not looked at your connected tools yet.'}</p>
        {err && <ErrorState error={err} />}
        <div className="flex flex-wrap gap-2">
          {d?.state === 'running' ? <Button size="sm" variant="ghost" onClick={reload}>Check again</Button> : <Button size="sm" onClick={run} disabled={busy !== null}><Icon name="search" size={15} />{busy === 'scan' ? 'Looking…' : 'Find work now'}</Button>}
        </div>
      </div>,
    )
  }
  return shell(
    <div data-state="ready" className="flex flex-col gap-6">
      <div>
        <h3 className="pb-2 text-[16px]">What Deploi found{d.sourcesRead.length ? <span className="font-normal text-grey-h"> in {d.sourcesRead.join(', ')}</span> : null}</h3>
        {d.findings.length === 0 ? <p className="text-[14px] text-grey">No problems found in what Deploi can read today. It keeps checking as your data changes.</p> : (
          <ul className="flex flex-col gap-2" aria-label="Findings">
            {d.findings.map(f => (
              <li key={f.key} className="rounded-[12px] border border-line p-3 text-[14px]">
                <div className="flex flex-wrap items-center gap-2">{f.priority && f.priority !== 'normal' && <Badge tone={f.priority === 'urgent' ? 'danger' : 'warn'}>{f.priority}</Badge>}<span className="font-medium text-ink">{f.title}</span></div>
                {f.problem && <p className="pt-1 text-grey">{f.problem}</p>}
                {f.caseRef && <Link href={caseHref(f.caseRef)} className="link text-[13px]">Open {f.caseRef}</Link>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="pb-2 text-[16px]">Your recommended team</h3>
        {d.recommendations.length === 0 ? <p className="text-[14px] text-grey">No agent is recommended for what was found.</p> : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2" aria-label="Recommended team">
            {d.recommendations.map(r => (
              <li key={r.template} className="rounded-[12px] border border-line p-3 text-[14px]" data-recommend={r.template}>
                <div className="font-medium text-ink">{r.name}</div>
                {r.reason && <p className="pt-1 text-grey">{r.reason}</p>}
                {r.needs.length > 0 && <p className="pt-1 text-[13px] text-warn">Still needs: {r.needs.join(', ')}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div aria-live="polite" className="flex flex-col gap-3">
        {done && <Banner icon="check"><strong>Done.</strong> {done} <Link href="/store/my-team">Open My AI Team</Link>.</Banner>}
        {err && <ErrorState error={err} />}
      </div>
      {!done && d.recommendations.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setUp(d.recommendations.map(r => r.template))} disabled={busy !== null} data-testid="set-up-team"><Icon name="users" size={16} />{busy === 'team' ? 'Setting up…' : 'Set up my team'}</Button>
          <span className="text-[13px] text-grey-h">Agents start at drafts only.</span>
        </div>
      )}
    </div>,
  )
}
