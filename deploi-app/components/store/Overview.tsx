'use client'
import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Tile } from '@/components/ui/Tile'
import { Icon } from '@/components/ui/Icon'
import { OUTCOME_LABEL } from '@/lib/engine/outcomes'
import { storeFetch, asApiError, StoreApiError } from './api'
import { useLoad } from './useLoad'
import { ErrorState, Facts, Loading, NoStore, Panel, Section, SyntheticBadge, useStore } from './bits'
import { CONNECTION_STATUS_LABEL, PLATFORM_LABEL, fmtAgo, fmtTime, planLabel } from './format'
import { OVERSELL_CHECK, type OverviewResponse, type RulesResponse, type ScanResult, type Connection } from './types'

const SETUP_HIDDEN_KEY = 'deploi.store.setupHidden'

function readHidden(): boolean {
  try { return window.sessionStorage.getItem(SETUP_HIDDEN_KEY) === '1' } catch { return false }
}
function writeHidden() {
  try { window.sessionStorage.setItem(SETUP_HIDDEN_KEY, '1') } catch { /* storage unavailable: hidden for this page view only */ }
}

type ScanState = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; r: ScanResult['scan'] } | { kind: 'error'; e: StoreApiError }

export function OverviewScreen() {
  const { base } = useStore()
  const { data, error, loading, reload } = useLoad(async () => {
    const o = await storeFetch<OverviewResponse>('/api/store/overview')
    const rules = o.connections.length ? await storeFetch<RulesResponse>('/api/store/rules').catch(() => null) : null
    return { o, rules }
  }, 'overview')
  const [scan, setScan] = useState<ScanState>({ kind: 'idle' })
  const [setupHidden, setSetupHidden] = useState<boolean>(() => typeof window !== 'undefined' && readHidden())
  const [setup, setSetup] = useState<{ busy: boolean; error: StoreApiError | null; done: boolean }>({ busy: false, error: null, done: false })

  if (loading && !data) return <><PageHeader title="Overview" /><Loading label="Loading your store" rows={4} /></>
  if (error && !data) return <><PageHeader title="Overview" /><ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const { o, rules } = data
  const conn: Connection | undefined = o.connections.find(c => c.status === 'active') ?? o.connections[0]
  const ov = o.overview
  const oversell = rules?.rules.find(r => r.check_key === OVERSELL_CHECK)
  const showSetup = Boolean(conn && oversell && !oversell.enabled && !setupHidden && o.actor.canApprove)
  const canScan = Boolean(conn && conn.status === 'active' && o.actor.canApprove)

  async function runScan() {
    setScan({ kind: 'running' })
    try {
      const r = await storeFetch<ScanResult>('/api/store/scan', { method: 'POST', body: conn ? { connectionId: conn.id } : {} })
      setScan({ kind: 'done', r: r.scan })
      await reload()
    } catch (e) { setScan({ kind: 'error', e: asApiError(e) }) }
  }

  async function turnOn() {
    if (!rules) return
    setSetup({ busy: true, error: null, done: false })
    try {
      await storeFetch('/api/store/rules', { method: 'PUT', body: { connectionId: rules.connectionId, checkKey: OVERSELL_CHECK, enabled: true } })
      setSetup({ busy: false, error: null, done: true })
      await reload()
    } catch (e) { setSetup({ busy: false, error: asApiError(e), done: false }) }
  }

  function decline() { writeHidden(); setSetupHidden(true) }

  return (
    <>
      <PageHeader
        eyebrow={o.org?.name ?? 'Your store'}
        title="Overview"
        sub="Deploi reads your store, shows what is wrong and why, and changes nothing until you approve the exact change."
        actions={conn ? (
          <Button variant={showSetup ? 'ghost' : 'primary'} size="sm" onClick={runScan} disabled={!canScan || scan.kind === 'running'} aria-label="Run scan: read the store and re-check every product">
            <Icon name="search" size={15} />{scan.kind === 'running' ? 'Scanning…' : 'Run scan'}
          </Button>
        ) : undefined}
      />

      <div aria-live="polite">
        {scan.kind === 'running' && <div className="mb-4"><Banner icon="clock"><strong>Scanning.</strong> Reading every product and variant from the store. This can take a minute on a large catalogue.</Banner></div>}
        {scan.kind === 'done' && (
          <div className="mb-4"><Banner icon="check"><strong>Scan finished.</strong> Read {scan.r.resourcesScanned} variant{scan.r.resourcesScanned === 1 ? '' : 's'}: {scan.r.issuesOpened} new issue{scan.r.issuesOpened === 1 ? '' : 's'}, {scan.r.issuesResolved} resolved, {scan.r.proposalsCreated} new proposal{scan.r.proposalsCreated === 1 ? '' : 's'}.</Banner></div>
        )}
        {scan.kind === 'error' && <div className="mb-4"><Banner tone="warn"><strong>Scan did not finish.</strong> {scan.e.message}. Nothing in the store was changed.</Banner></div>}
        {setup.done && <div className="mb-4"><Banner icon="check"><strong>Check turned on.</strong> Deploi re-read the store with your rule. Products marked pre-order or backorder are skipped.</Banner></div>}
        {error && <div className="mb-4"><ErrorState error={error} onRetry={reload} /></div>}
      </div>

      {!o.actor.canApprove && <div className="mb-4"><Banner tone="warn"><strong>Read-only.</strong> Deploi staff can view this store but cannot approve or change anything.</Banner></div>}

      {!conn ? <NoStore /> : (
        <>
          {showSetup && (
            <div className="mb-6 metal rounded-[20px] p-5 md:p-6 fade-up" aria-labelledby="setup-q">
              <div className="relative flex flex-col gap-4">
                <span className="glass muted self-start" style={{ fontSize: 13, padding: '6px 12px' }}><Icon name="spark" size={14} />One question to set up</span>
                <h2 id="setup-q" className="text-[1.3rem] md:text-[1.5rem] max-w-[34ch]">Should products stop selling when they run out, except the ones you mark as pre-order or backorder?</h2>
                <p className="text-[15px] text-grey max-w-[60ch]">
                  If yes, Deploi turns on its check for products set to &ldquo;Continue selling when out of stock&rdquo;. It skips products tagged pre-order, backorder or made-to-order, products sold through selling plans, gift cards and untracked inventory. Nothing changes in your store until you approve each change.
                </p>
                {setup.error && <Banner tone="warn"><strong>Not saved.</strong> {setup.error.message}</Banner>}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={turnOn} disabled={setup.busy}><Icon name="check" size={15} />{setup.busy ? 'Turning on…' : 'Yes, turn this check on'}</Button>
                  <Button size="sm" variant="ghost" onClick={decline} disabled={setup.busy}>No, I sell past zero on purpose</Button>
                </div>
              </div>
            </div>
          )}

          <ConnectionCard conn={conn} lastScan={ov.lastScan} />

          {conn.status !== 'active' && <div className="mt-4"><Banner tone="warn"><strong>Blocked.</strong> The store connection is {CONNECTION_STATUS_LABEL[conn.status]?.toLowerCase() ?? conn.status}. Scans and changes are paused until the app is installed again.</Banner></div>}

          <Section title="Issues" sub="Open problems from the latest read of your store.">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              <Tile label="Open issues" value={ov.openIssues} href={`${base}/issues`} tone={ov.openIssues ? 'warn' : 'none'} />
              <Tile label="High severity" value={ov.highSeverity} href={`${base}/issues`} tone={ov.highSeverity ? 'danger' : 'none'} />
              <Tile label="Needs a person" value={ov.needsPerson} href={`${base}/issues?kind=needs_person`} />
              <Tile label="Waiting for approval" value={ov.waitingApproval} href={`${base}/issues?kind=correctable`} />
              <Tile label="Needs review" value={ov.needsReview} href={`${base}/issues`} tone={ov.needsReview ? 'warn' : 'none'} />
            </div>
          </Section>

          <Section title="Changes in the last 30 days" sub="Every approved change ends in one of these outcomes. Only Verified means a fresh read shows the change.">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {(['pending', 'verified', 'failed', 'blocked'] as const).map(k => (
                <Tile key={k} label={OUTCOME_LABEL[k]} value={ov.executions30d[k] ?? 0} href={`${base}/activity?outcome=${k}`}
                  tone={k === 'verified' && ov.executions30d[k] ? 'ok' : k === 'failed' && ov.executions30d[k] ? 'danger' : k === 'blocked' && ov.executions30d[k] ? 'warn' : 'none'} />
              ))}
            </div>
          </Section>
        </>
      )}

      <div className="mt-8 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Panel>
          <h2 className="text-[1.05rem]">Platforms</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {o.platforms.map(p => (
              <li key={p.platform} className="flex items-center justify-between gap-3 text-[15px]">
                <span className="text-ink">{PLATFORM_LABEL[p.platform] ?? p.platform}</span>
                {p.status === 'operational' ? <Badge tone="ok">Available</Badge> : <Badge tone="muted">Planned</Badge>}
              </li>
            ))}
          </ul>
          <p className="pt-3 text-[13px] text-grey-h">One connected store is all Deploi needs. WooCommerce and Amazon are planned and not available yet.</p>
        </Panel>
        <Panel>
          <h2 className="text-[1.05rem]">Subscription</h2>
          {ov.subscription ? (
            <p className="pt-3 text-[15px] text-ink">{planLabel(ov.subscription)}</p>
          ) : (
            <p className="pt-3 text-[15px] text-grey">No subscription on record.</p>
          )}
          {ov.subscription?.current_period_end && <p className="pt-1 text-[13px] text-grey-h">Current period ends {fmtTime(ov.subscription.current_period_end)}</p>}
        </Panel>
      </div>
    </>
  )
}

function ConnectionCard({ conn, lastScan }: { conn: Connection; lastScan: OverviewResponse['overview']['lastScan'] }) {
  const { base } = useStore()
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2">
        <span className="glass" style={{ fontSize: 13, padding: '6px 12px' }}><Icon name="building" size={14} />{PLATFORM_LABEL[conn.platform] ?? conn.platform}</span>
        <Badge tone={conn.status === 'active' ? 'ok' : 'warn'}>{CONNECTION_STATUS_LABEL[conn.status] ?? conn.status}</Badge>
        {conn.is_synthetic && <SyntheticBadge />}
      </div>
      <div className="mt-3 text-ink font-medium break-all">{conn.display_name ?? conn.external_id}</div>
      <div className="text-[14px] text-grey-h break-all">{conn.external_id}</div>
      <div className="mt-4">
        <Facts items={[
          ['Last scan', lastScan ? <>{fmtAgo(lastScan.finished_at ?? lastScan.started_at)}{lastScan.status === 'failed' ? <> · <span className="text-danger">failed</span></> : lastScan.status === 'running' ? ' · running' : ''}</> : 'Not scanned yet'],
          ...(lastScan && lastScan.finished_at ? [['Last read', `${lastScan.resources_scanned} variant${lastScan.resources_scanned === 1 ? '' : 's'} · ${lastScan.issues_opened} new · ${lastScan.issues_resolved} resolved`] as [string, string]] : []),
          ...(lastScan?.error ? [['Scan error', lastScan.error] as [string, string]] : []),
        ]} />
      </div>
      <Link href={`${base}/connect`} className="mt-4 inline-flex text-[14px]"><span className="inline-flex items-center gap-1 text-ink underline-offset-4 hover:underline">Store details<Icon name="arrow-right" size={14} /></span></Link>
    </Panel>
  )
}
