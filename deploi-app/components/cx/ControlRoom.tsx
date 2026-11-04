'use client'
/**
 * Control Room: the owner's home. Live status of every agent, what waits for approval, recent actions and
 * whether they were verified, connection health, issues by severity, the weekly estimate, and an
 * organization-wide Stop all agents control behind a confirmation.
 */
import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Icon } from '@/components/ui/Icon'
import { Sheet } from '@/components/ui/Sheet'
import { Tile } from '@/components/ui/Tile'
import { OUTCOME_LABEL } from '@/lib/engine/outcomes'
import { storeFetch, asApiError, StoreApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, OutcomeBadge, Panel, Section, SyntheticBadge, useStore } from '@/components/store/bits'
import { StoreAccessCard } from '@/components/store/StoreAccess'
import { BillingBanner } from '@/components/store/Billing'
import { PLATFORM_LABEL, changeInWords, fmtAgo, fmtTime } from '@/components/store/format'
import type { ScanResult } from '@/components/store/types'
import { probe, useProbes, ROUTES } from './probe'
import { HEALTH_WORDS, TIER_WORDS, minutesInWords, type ControlRoomResponse, type StopAllResult, type WizardResponse } from './types'

type UnifiedApprovals = { count: number; items: { id: string; title: string; source: string; agentName: string | null }[] } | null

/** Read the unified approvals API when it exists; any shape it returns is read defensively. */
async function unifiedApprovals(): Promise<UnifiedApprovals> {
  const r = await probe(ROUTES.approvalsApi)
  if (r.availability !== 'available' || r.status !== 200 || !r.json || typeof r.json !== 'object') return null
  const j = r.json as Record<string, unknown>
  const list = (Array.isArray(j.approvals) ? j.approvals : Array.isArray(j.items) ? j.items : null) as Record<string, unknown>[] | null
  if (!list) return null
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  return {
    count: typeof j.count === 'number' ? j.count : list.length,
    items: list.slice(0, 10).map((x, i) => ({ id: String(x.id ?? i), title: str(x.title) ?? str(x.summary) ?? str(x.subject) ?? 'Waiting for your decision', source: str(x.source) ?? str(x.kind) ?? 'approval', agentName: str(x.agentName) ?? str(x.agent_name) })),
  }
}

type Stop = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; r: StopAllResult; via: 'org' | 'agents' } | { kind: 'error'; e: StoreApiError }
type Scan = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; r: ScanResult['scan'] } | { kind: 'error'; e: StoreApiError }

export function ControlRoomScreen() {
  const { base } = useStore()
  const { data, error, loading, reload } = useLoad(async () => {
    const [cr, approvals, wizard] = await Promise.all([
      storeFetch<ControlRoomResponse>('/api/store/control-room'),
      unifiedApprovals(),
      storeFetch<WizardResponse>('/api/store/onboarding').then(r => r.wizard).catch(() => null),
    ])
    return { cr, approvals, wizard }
  }, 'control-room')
  const probes = useProbes([ROUTES.officeConnections])
  const [confirm, setConfirm] = useState(false)
  const [stop, setStop] = useState<Stop>({ kind: 'idle' })
  const [clearing, setClearing] = useState(false)
  const [scan, setScan] = useState<Scan>({ kind: 'idle' })

  const header = (actions?: React.ReactNode) => <PageHeader eyebrow={data?.cr.org.name ?? 'Your organization'} title="Control Room" sub="Every agent, what waits for you, and what was verified. Agents act only within what you granted; you can stop them all at once." actions={actions} />
  if (loading && !data) return <>{header()}<Loading label="Loading the Control Room" rows={4} /></>
  if (error && !data) return <>{header()}<ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const { cr, approvals, wizard } = data
  const store = cr.connections.stores.find(s => s.status === 'active') ?? cr.connections.stores[0]
  const running = cr.agents.filter(a => a.status === 'active').length + cr.library.switchedOn
  const pendingCount = approvals?.count ?? cr.approvals.count

  async function stopAll() {
    setStop({ kind: 'busy' })
    try {
      // the Control Room route sets the organization stop switch (agents paused, queued work cancelled, sends held)
      const r = await storeFetch<StopAllResult & { ok: true }>('/api/store/control-room/stop-all', { method: 'POST', body: { confirm: 'stop' } })
      setStop({ kind: 'done', via: 'org', r })
      setConfirm(false)
    } catch (e) { setStop({ kind: 'error', e: asApiError(e) }) }
    await reload()
  }
  async function clearOrgStop() {
    setClearing(true)
    try { await storeFetch('/api/store/control-room/stop-all', { method: 'POST', body: { action: 'clear' } }); setStop({ kind: 'idle' }) } catch (e) { setStop({ kind: 'error', e: asApiError(e) }) }
    setClearing(false)
    await reload()
  }
  async function runScan() {
    if (!store) return
    setScan({ kind: 'running' })
    try { const r = await storeFetch<ScanResult>('/api/store/scan', { method: 'POST', body: { connectionId: store.id } }); setScan({ kind: 'done', r: r.scan }); await reload() } catch (e) { setScan({ kind: 'error', e: asApiError(e) }) }
  }

  return (
    <>
      {header(cr.canAct ? (
        <>
          {store && store.status === 'active' && <Button size="sm" variant="ghost" onClick={runScan} disabled={scan.kind === 'running'} aria-label="Run scan: read the store and re-check every product"><Icon name="search" size={15} />{scan.kind === 'running' ? 'Scanning…' : 'Run scan'}</Button>}
          <Button size="sm" variant="danger" onClick={() => { setStop({ kind: 'idle' }); setConfirm(true) }} disabled={stop.kind === 'busy'} data-testid="stop-all"><Icon name="alert" size={15} />Stop all agents</Button>
        </>
      ) : undefined)}

      <div aria-live="polite" className="flex flex-col gap-3">
        {wizard && !wizard.completedAt && <Banner icon="spark"><strong>Finish setting up.</strong> {wizard.steps.filter(s => s.state === 'done' || s.state === 'skipped').length} of {wizard.steps.length} steps done. <Link href={`${base}/onboarding`} className="text-ink underline">Continue setup</Link></Banner>}
        {cr.orgStop && <div data-testid="org-stopped"><Banner tone="warn"><strong>All agents are stopped.</strong> {cr.orgStop.reason ? `${cr.orgStop.reason}. ` : ''}Nothing runs, changes your store or sends email until you turn the stop off; then resume each agent from its page.{cr.canAct && <> <Button size="sm" variant="ghost" onClick={clearOrgStop} disabled={clearing} data-testid="clear-stop">Turn the stop off</Button></>}</Banner></div>}
        {stop.kind === 'done' && <Banner icon="check"><strong>All agents stopped.</strong> {stop.r.paused} paused{stop.r.librarySwitchedOff ? `, ${stop.r.librarySwitchedOff} library agent${stop.r.librarySwitchedOff === 1 ? '' : 's'} switched off` : ''}{stop.r.alreadyStopped ? `; ${stop.r.alreadyStopped} were not running` : ''}. Queued changes and emails were cancelled. Turn the stop off when you are ready, then resume each agent from its page.{stop.r.failed.length ? ` Not stopped: ${stop.r.failed.map(f => `${f.name} (${f.message})`).join(', ')}.` : ''}</Banner>}
        {stop.kind === 'error' && <Banner tone="warn"><strong>Not stopped.</strong> {stop.e.message}</Banner>}
        {scan.kind === 'running' && <Banner icon="clock"><strong>Scanning.</strong> Reading every product and variant. Nothing is changed.</Banner>}
        {scan.kind === 'done' && <Banner icon="check"><strong>Scan finished.</strong> Read {scan.r.resourcesScanned} variant{scan.r.resourcesScanned === 1 ? '' : 's'}: {scan.r.issuesOpened} new issue{scan.r.issuesOpened === 1 ? '' : 's'}, {scan.r.issuesResolved} resolved.</Banner>}
        {scan.kind === 'error' && <Banner tone="warn"><strong>Scan did not finish.</strong> {scan.e.message}. Nothing in the store was changed.</Banner>}
        {!cr.canAct && <Banner tone="warn"><strong>Read-only.</strong> Deploi staff can view but not change anything.</Banner>}
        {error && <ErrorState error={error} onRetry={reload} />}
      </div>

      {store && store.status === 'active' && !store.synthetic && <div className="mt-3"><StoreAccessCard connectionId={store.id} canAct={cr.canAct} /></div>}
      {store && store.platform === 'shopify' && store.status === 'active' && <BillingBanner connectionId={store.id} canAct={cr.canAct} />}

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" data-testid="cr-tiles">
        <Tile label="Agents running" value={running} sub={`${cr.counts.total} agent${cr.counts.total === 1 ? '' : 's'} in all`} href={`${base}/agents`} tone={running ? 'ok' : 'none'} />
        <Tile label="Need attention" value={cr.counts.needsAttention + cr.counts.draft} href="#agents" tone={cr.counts.needsAttention + cr.counts.draft ? 'warn' : 'none'} />
        <Tile label="Waiting for approval" value={<span data-testid="approvals-count">{pendingCount}</span>} sub={cr.approvals.drafts ? `${cr.approvals.drafts} draft${cr.approvals.drafts === 1 ? '' : 's'} to review` : undefined} href={`${base}/inbox`} />
        <Tile label="High-severity issues" value={cr.issues.high} href={`${base}/issues`} tone={cr.issues.high ? 'danger' : 'none'} />
        <Tile label="Time saved this week" value={minutesInWords(cr.weekly.minutes)} sub="Estimate" />
      </div>

      <Section id="agents" title="Agents" sub="Live status, last and next run, and the permission each one holds. Open an agent to change, pause or revoke it.">
        {cr.agents.length === 0 ? (
          <Empty title="No agents yet">Set up your first agents at drafts only. <Link href={`${base}/onboarding`} className="text-ink underline">Start setup</Link> or <Link href={`${base}/agents/new`} className="text-ink underline">create one</Link>.</Empty>
        ) : (
          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2" aria-label="Agents">
            {cr.agents.map(a => {
              const h = HEALTH_WORDS[a.health]
              return (
                <li key={a.id} data-agent={a.name}>
                  <Panel tone={a.health === 'needs_attention' || a.health === 'draft' ? 'warn' : undefined} className="h-full">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link href={`${base}/agents/${a.id}`} className="min-w-0 break-words text-[1.05rem] font-medium text-ink underline-offset-4 hover:underline">{a.name}</Link>
                      <Badge tone={h.tone}>{h.label}</Badge>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[14px]">
                      <div><dt className="text-grey-h">Last run</dt><dd className="m-0 text-ink">{a.lastRunAt ? <>{fmtAgo(a.lastRunAt)}{a.lastRunStatus && a.lastRunStatus !== 'completed' ? ` · ${a.lastRunStatus}` : ''}</> : 'Not yet'}</dd></div>
                      <div><dt className="text-grey-h">Next run</dt><dd className="m-0 text-ink">{a.nextRunAt ? fmtTime(a.nextRunAt) : a.status === 'active' ? 'On demand' : '—'}</dd></div>
                      <div><dt className="text-grey-h">Store permission</dt><dd className="m-0 text-ink">{a.storeTier ? TIER_WORDS[a.storeTier] : 'None'}</dd></div>
                      <div><dt className="text-grey-h">Email permission</dt><dd className="m-0 text-ink">{a.emailTier ? TIER_WORDS[a.emailTier] : 'None'}</dd></div>
                      <div className="col-span-2"><dt className="text-grey-h">Authorization</dt><dd className="m-0 text-ink">{a.version ? `Version ${a.version}` : 'Not granted'}{a.expiresAt ? ` · standing authorization ends ${fmtTime(a.expiresAt)}` : a.version ? ' · no end date (asks or drafts)' : ''}</dd></div>
                    </dl>
                    {a.attention.length > 0 && <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-[14px] text-warn">{a.attention.map(x => <li key={x}>{x}</li>)}</ul>}
                  </Panel>
                </li>
              )
            })}
          </ul>
        )}
        {cr.library.switchedOn > 0 && <p className="pt-3 text-[13px] text-grey-h">{cr.library.switchedOn} library agent{cr.library.switchedOn === 1 ? ' is' : 's are'} switched on in <Link href={`${base}/team`} className="text-ink underline">Team</Link>.</p>}
      </Section>

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <Section id="approvals" title="Waiting for you" sub={approvals ? 'From the approvals inbox.' : 'Exact changes and emails your agents are waiting on.'} actions={<Link href={`${base}/inbox`} className="btn ghost xs">Open approvals<Icon name="arrow-right" size={14} /></Link>}>
          {(approvals?.items ?? cr.approvals.items).length === 0 ? <Empty title="Nothing waiting">No approvals right now.</Empty> : (
            <ul className="flex flex-col gap-2" aria-label="Waiting for approval">
              {(approvals?.items ?? cr.approvals.items).map(i => (
                <li key={`${i.source}:${i.id}`} className="rounded-[16px] border border-line p-3 text-[14px]">
                  <div className="flex flex-wrap items-center gap-2"><Badge tone="muted">{i.source === 'email' ? 'Email' : i.source === 'change' ? 'Store change' : i.source}</Badge><span className="min-w-0 break-words text-ink">{i.title}</span></div>
                  {i.agentName && <div className="pt-1 text-grey-h">{i.agentName}</div>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="recent" title="Recent actions" sub="Only Verified means a fresh read shows the change." actions={<Link href={`${base}/activity`} className="btn ghost xs">All activity<Icon name="arrow-right" size={14} /></Link>}>
          <div className="mb-3 flex flex-wrap gap-2 text-[13px]">{(['verified', 'pending', 'failed', 'blocked'] as const).map(k => <Badge key={k} tone={k === 'verified' ? 'ok' : k === 'failed' && cr.verification[k] ? 'danger' : 'muted'}>{OUTCOME_LABEL[k]} {cr.verification[k] ?? 0}</Badge>)}</div>
          {cr.recent.length === 0 ? <Empty title="No actions yet">Approved and authorized changes appear here with their verification.</Empty> : (
            <ul className="flex flex-col gap-2" aria-label="Recent actions">
              {cr.recent.map(r => {
                const c = changeInWords({ field: r.field, from: r.from, to: r.to })
                return (
                  <li key={r.id} className="rounded-[16px] border border-line p-3 text-[14px]">
                    <div className="flex flex-wrap items-center gap-2"><OutcomeBadge outcome={r.outcome} /><span className="min-w-0 break-words text-ink">{r.target ?? 'Record'}</span></div>
                    <div className="pt-1 text-grey">{c.label}: {c.from} → {c.to} · {fmtAgo(r.verifiedAt ?? r.startedAt)}</div>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <Section id="connections" title="Connections" actions={<Link href={`${base}/integrations`} className="btn ghost xs">Integrations<Icon name="arrow-right" size={14} /></Link>}>
          <ul className="flex flex-col gap-2 text-[14px]" aria-label="Connection health">
            {cr.connections.stores.length === 0 && <li className="rounded-[16px] border border-line p-3 text-grey">No store connected. <Link href={`${base}/integrations`} className="text-ink underline">Connect one</Link>.</li>}
            {cr.connections.stores.map(s => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[16px] border border-line p-3">
                <span className="min-w-0 break-all text-ink">{PLATFORM_LABEL[s.platform] ?? s.platform} · {s.name}</span>
                <span className="flex flex-wrap gap-2">{s.synthetic && <SyntheticBadge />}<Badge tone={s.status === 'active' ? 'ok' : 'warn'}>{s.status === 'active' ? 'Healthy' : s.status}</Badge></span>
                <span className="w-full text-grey-h">Last scan {s.lastScanAt ? fmtAgo(s.lastScanAt) : 'not yet'} · <Link href={`${base}/control-room/overview`} className="text-ink underline">Store overview</Link></span>
              </li>
            ))}
            <li className="flex flex-wrap items-center justify-between gap-2 rounded-[16px] border border-line p-3">
              <span className="text-ink">Agent mailboxes</span>
              <Badge tone={cr.connections.mailboxes.agentMailboxes ? 'ok' : cr.connections.mailboxes.domainConfigured ? 'muted' : 'muted'}>{cr.connections.mailboxes.agentMailboxes ? `${cr.connections.mailboxes.agentMailboxes} address${cr.connections.mailboxes.agentMailboxes === 1 ? '' : 'es'}` : cr.connections.mailboxes.domainConfigured ? 'None yet' : 'Needs setup'}</Badge>
              <span className="w-full text-grey-h">Live sending {cr.connections.mailboxes.liveSends === 'all' ? 'on' : cr.connections.mailboxes.liveSends === 'allowlist' ? 'to test recipients only' : 'off: approved messages are held'}</span>
            </li>
            {cr.connections.email.map(e => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[16px] border border-line p-3">
                <span className="min-w-0 break-all text-ink">{e.address}</span>
                <span className="flex gap-2"><Badge tone="muted">Not live-verified</Badge><Badge tone={e.status === 'active' ? 'ok' : 'warn'}>{e.status === 'active' ? 'Healthy' : e.status.replace('_', ' ')}</Badge></span>
              </li>
            ))}
            {cr.products.includes('office') && (
              <li className="flex flex-wrap items-center justify-between gap-2 rounded-[16px] border border-line p-3">
                <span className="text-ink">Deploi Office (HubSpot, Google Calendar)</span>
                {probes[ROUTES.officeConnections] === 'available'
                  ? <Link href={ROUTES.officeConnections} className="text-ink underline">Check in Deploi Office</Link>
                  : <Badge tone="muted">{probes[ROUTES.officeConnections] === 'checking' ? 'Checking…' : 'Not available yet'}</Badge>}
              </li>
            )}
          </ul>
        </Section>

        <Section id="issues" title="Issues by severity" actions={<Link href={`${base}/issues`} className="btn ghost xs">All issues<Icon name="arrow-right" size={14} /></Link>}>
          <div className="grid grid-cols-2 gap-3">
            {([['high', 'High', 'danger'], ['medium', 'Medium', 'warn'], ['low', 'Low', 'none']] as const).map(([k, label, tone]) => <Tile key={k} label={label} value={cr.issues[k]} tone={cr.issues[k] ? tone : 'none'} />)}
            <Tile label="Need a person" value={cr.issues.needsPerson} />
          </div>
          <p className="pt-3 text-[13px] text-grey-h">Time saved is an estimate: {cr.weekly.formula}.</p>
        </Section>
      </div>

      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Stop all agents?">
        <div className="flex flex-col gap-4">
          <p className="text-[15px] text-grey">Every agent in {cr.org.name} is paused now{cr.library.switchedOn ? ' and every library agent is switched off' : ''}. Nothing runs, reads or writes. Changes waiting for approval or already queued are cancelled, and queued emails are not sent. Authorizations are kept, so you can resume each agent from its page without granting again.</p>
          <p className="text-[14px] text-ink">{running} running now.</p>
          {stop.kind === 'error' && <Banner tone="warn"><strong>Not stopped.</strong> {stop.e.message}</Banner>}
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" onClick={stopAll} disabled={stop.kind === 'busy'}>{stop.kind === 'busy' ? 'Stopping…' : 'Yes, stop all agents'}</Button>
            <Button variant="ghost" onClick={() => setConfirm(false)} disabled={stop.kind === 'busy'}>Cancel</Button>
          </div>
        </div>
      </Sheet>
    </>
  )
}
