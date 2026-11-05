'use client'
/**
 * Integrations: one card per tool Deploi connects to, from the integration hub (lib/integrations/registry.ts):
 * status and last check, what Deploi uses it for, permissions and the scopes it asks for (and why), Test
 * (a read-only probe, recorded), Reconnect in place (same connection, so agents and cases keep working),
 * Disconnect, and an "Advanced" drawer with diagnostics (recent checks, error codes, API calls this month,
 * rate-limit headroom, webhook state with Re-register where the provider allows it, token expiry).
 * A tool this deployment is not set up for reads "Not available yet" (the missing settings are shown to staff only).
 */
import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Icon } from '@/components/ui/Icon'
import { Sheet } from '@/components/ui/Sheet'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { fmtAgo, fmtTime } from '@/components/store/format'
import { ErrorState, Loading, Panel, Section } from '@/components/store/bits'
import { STATUS_WORDS, type ConnectionView, type IntegrationView, type Suite, type TestOutcome } from '@/lib/integrations/types'
import type { Diagnostics } from '@/lib/integrations/diagnostics'
import type { Availability } from './probe'
import type { Integration, IntegrationStatus } from './types'

type ListResponse = { ok: true; integrations: IntegrationView[] }
type TestResponse = { ok: true; status: IntegrationView['status']; message: string; results: TestOutcome[] }
type ActionResponse = { ok: true; result: { kind: 'redirect'; url: string } | { kind: 'link'; href: string; message: string } | { kind: 'done'; connectionId: string; message: string } }
type DiagResponse = { ok: true; integration: IntegrationView; diagnostics: Diagnostics }

const GROUPS: { key: Suite; title: string; sub: string }[] = [
  { key: 'commerce', title: 'Deploi Commerce', sub: 'Your store. Connect one platform; that is all Deploi Commerce needs.' },
  { key: 'office', title: 'Deploi Office', sub: 'CRM, calendar and accounting for lead follow-up, scheduling and receivables.' },
  { key: 'email', title: 'Email', sub: 'Where agents write from. Connecting an account authorizes no agent; each agent gets its own email permission.' },
  { key: 'billing', title: 'Billing', sub: 'Your subscription.' },
]

/** Kept for the older connection cards: a page that is not deployed yet turns any status into "not available yet". */
export function effectiveStatus(i: Integration, availability: Availability | undefined): { status: IntegrationStatus; linkable: boolean } {
  if (!i.probe) return { status: i.status, linkable: i.status !== 'not_available' || i.key === 'shopify' }
  if (availability === 'missing') return { status: i.status === 'connected' ? 'connected' : 'not_available', linkable: false }
  return { status: i.status, linkable: availability === 'available' }
}

const broken = (c: ConnectionView) => c.status === 'needs_reauth' || c.status === 'error'

function IntegrationCard({ i, onChanged, onAdvanced }: { i: IntegrationView; onChanged: () => void; onAdvanced: () => void }) {
  const w = STATUS_WORDS[i.status]
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const post = async <T,>(body: Record<string, unknown>) => storeFetch<T>(`/api/store/integrations/${i.key}`, { method: 'POST', body })
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setNote(null)
    try { await fn() } catch (e) { setNote({ tone: 'danger', text: asApiError(e).message }) } finally { setBusy(null) }
  }
  const test = () => run('test', async () => {
    const r = await post<TestResponse>({ op: 'test' })
    setNote({ tone: r.results.every(x => x.ok) && r.results.length ? 'ok' : 'warn', text: r.message })
    onChanged()
  })
  const reconnect = (c: ConnectionView) => run(`reconnect:${c.id}`, async () => {
    const r = (await post<ActionResponse>({ op: 'reconnect', connectionId: c.id })).result
    if (r.kind === 'redirect') { window.location.assign(r.url); return }
    if (r.kind === 'link') { window.location.assign(r.href); return }
    setNote({ tone: 'ok', text: r.message })
    onChanged()
  })
  const disconnect = (c: ConnectionView) => run(`disconnect:${c.id}`, async () => {
    const r = await post<{ ok: true; message: string }>({ op: 'disconnect', connectionId: c.id })
    setConfirm(null); setNote({ tone: 'ok', text: r.message }); onChanged()
  })
  const available = i.status !== 'not_configured'
  return (
    <li data-integration={i.key} data-status={i.status}>
      <Panel className="h-full" tone={i.status === 'needs_reauth' ? 'warn' : i.status === 'error' ? 'danger' : undefined}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[1.05rem]">{i.name}</h3>
          <span className="flex flex-wrap gap-2">{!i.liveVerified && <Badge tone="muted">Not live-verified</Badge>}<Badge tone={w.tone}><span data-testid="status-label">{w.label}</span></Badge></span>
        </div>
        <p className="pt-2 text-[14px] text-grey-h break-words" data-testid="detail">{i.detail}</p>
        {available && i.connections.length > 0 && (
          <p className="pt-1 text-[13px] text-grey-h" data-testid="last-check">
            {i.lastCheckedAt ? <>Last check {fmtAgo(i.lastCheckedAt)}</> : 'Not checked yet'}
            {i.lastSuccessAt ? <> · last successful call {fmtAgo(i.lastSuccessAt)}</> : null}
          </p>
        )}
        <p className="pt-3 text-[15px] text-grey"><span className="text-ink">Used for: </span>{i.usedFor}</p>
        <div className="pt-3">
          <div className="text-[14px] text-ink">What it lets Deploi do</div>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-[14px] text-grey">{i.permissions.map(p => <li key={p}>{p}</li>)}</ul>
        </div>
        {i.scopes.length > 0 && (
          <details className="pt-3 text-[14px]">
            <summary className="cursor-pointer text-ink">Permissions requested, and why</summary>
            <ul className="mt-2 flex flex-col gap-1">{i.scopes.map(s => <li key={s.scope} className="text-grey"><code className="text-[12px] text-ink break-all">{s.scope}</code>: {s.why}</li>)}</ul>
          </details>
        )}
        {i.connections.filter(broken).map(c => (
          <div key={c.id} className="mt-3 rounded-[12px] border border-warn-line p-3 text-[14px]" data-testid="reconnect-box">
            <div className="text-ink">{c.label}{c.synthetic ? ' (synthetic test account)' : ''}: {c.status === 'needs_reauth' ? 'needs reconnecting' : 'not working'}</div>
            {c.reason && <div className="pt-1 text-grey-h break-words">{c.reason}</div>}
            <div className="pt-1 text-grey-h">Reconnecting keeps this connection, its agents and their work{i.scopes.length ? `, and asks again for the permissions listed above` : ''}. Agents waiting on it resume once it works.</div>
            {i.can.reconnect && <button className="btn xs mt-2" disabled={busy !== null} onClick={() => reconnect(c)} aria-label={`Reconnect ${i.name}`}>{busy === `reconnect:${c.id}` ? 'Reconnecting…' : 'Reconnect'}</button>}
          </div>
        ))}
        {note && <p className={`mt-3 text-[14px] ${note.tone === 'danger' ? 'text-danger' : note.tone === 'warn' ? 'text-warn' : 'text-ok'}`} role="status" data-testid="test-result">{note.text}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          {available && i.connections.length === 0 && i.can.connect && (
            <Link href={i.connectHref} className="btn ghost xs" aria-label={`Connect ${i.name}`}>Connect<Icon name="arrow-right" size={14} /></Link>
          )}
          {i.can.test && <button className="btn ghost xs" disabled={busy !== null} onClick={test} aria-label={`Test ${i.name}`}>{busy === 'test' ? 'Testing…' : 'Test'}</button>}
          {i.connections.length > 0 && <button className="btn ghost xs" onClick={onAdvanced} aria-label={`Advanced diagnostics for ${i.name}`}>Advanced</button>}
          {i.can.disconnect && i.connections.map(c => confirm === c.id ? (
            <span key={c.id} className="flex flex-wrap items-center gap-2 text-[14px]">Disconnect {c.label}?
              <button className="btn danger xs" disabled={busy !== null} onClick={() => disconnect(c)}>Yes, disconnect</button>
              <button className="btn ghost xs" onClick={() => setConfirm(null)}>Keep it</button>
            </span>
          ) : (
            <button key={c.id} className="btn ghost xs" onClick={() => setConfirm(c.id)} aria-label={`Disconnect ${c.label}`}>Disconnect{i.connections.length > 1 ? ` ${c.label}` : ''}</button>
          ))}
          {available && i.connections.length > 0 && <Link href={i.connectHref} className="btn ghost xs" aria-label={`Manage ${i.name}`}>Manage<Icon name="arrow-right" size={14} /></Link>}
        </div>
      </Panel>
    </li>
  )
}

function DiagnosticsSheet({ keyName, onClose }: { keyName: IntegrationView['key']; onClose: () => void }) {
  const { data, error, loading, reload } = useLoad(() => storeFetch<DiagResponse>(`/api/store/integrations/${keyName}`), `diag:${keyName}`)
  const [msg, setMsg] = useState<string | null>(null)
  const reregister = async (connectionId: string) => {
    setMsg(null)
    try { const r = await storeFetch<{ ok: true; message: string }>(`/api/store/integrations/${keyName}`, { method: 'POST', body: { op: 'webhooks', connectionId } }); setMsg(r.message); reload() } catch (e) { setMsg(asApiError(e).message) }
  }
  return (
    <Sheet open onClose={onClose} title={data ? `${data.integration.name}: diagnostics` : 'Diagnostics'}>
      {loading && !data && <Loading label="Loading diagnostics" rows={3} />}
      {error && !data && <ErrorState error={error} onRetry={reload} />}
      {data && (
        <div className="flex flex-col gap-5 text-[14px]" data-testid="diagnostics">
          {data.diagnostics.callsThisMonth !== null && <p className="text-grey">API calls this month: <span className="text-ink">{data.diagnostics.callsThisMonth}</span></p>}
          {data.diagnostics.connections.map(c => (
            <div key={c.connectionId} className="flex flex-col gap-2">
              <h3 className="text-[1rem]">{c.label}{c.synthetic ? ' (synthetic)' : ''}</h3>
              {c.token && <p className="text-grey">Authorization: {c.token.stored ? <>{c.token.kind ?? 'stored'}{c.token.expiresAt ? <>, access expires {fmtTime(c.token.expiresAt)}</> : ', no expiry'}{c.token.refreshExpiresAt ? <>, renewal expires {fmtTime(c.token.refreshExpiresAt)}</> : null}</> : 'none stored (reconnect to restore it)'}</p>}
              {c.rateLimit && <p className="text-grey">Rate-limit headroom: {Object.entries(c.rateLimit).filter(([, v]) => v !== null).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()} ${String(v)}`).join(', ') || 'not reported'}</p>}
              {c.webhooks && (
                <div className="rounded-[12px] border border-line p-3" data-testid="webhooks">
                  <div className="text-ink">Webhooks</div>
                  <p className="pt-1 text-grey">{c.webhooks.summary}</p>
                  {c.webhooks.topics.length > 0 && <ul className="pt-1 text-grey">{c.webhooks.topics.map(t => <li key={t.topic}>{t.topic}: {t.registered === null ? 'not checked' : t.registered ? 'registered' : 'missing'}</li>)}</ul>}
                  {c.webhooks.lastDeliveryAt && <p className="pt-1 text-grey">Last delivery {fmtAgo(c.webhooks.lastDeliveryAt)}{c.webhooks.failedDeliveries7d ? `; ${c.webhooks.failedDeliveries7d} failed in 7 days` : ''}</p>}
                  {c.webhooks.error && <p className="pt-1 text-warn">{c.webhooks.error}</p>}
                  {c.webhooks.canReregister && <button className="btn ghost xs mt-2" onClick={() => reregister(c.connectionId)}>Re-register webhooks</button>}
                </div>
              )}
              {c.errorCodes.length > 0 && <p className="text-grey">Errors in the last 7 days: {c.errorCodes.map(e => `${e.code} ×${e.count}`).join(', ')}</p>}
              <div>
                <div className="text-ink">Recent checks</div>
                {c.recentChecks.length === 0 ? <p className="text-grey-h">No checks yet. Use Test.</p> : (
                  <ul className="mt-1 flex flex-col gap-1">{c.recentChecks.map((r, n) => (
                    <li key={n} className="text-grey break-words"><Badge tone={r.ok ? 'ok' : 'warn'}>{r.ok ? 'ok' : r.code ?? 'failed'}</Badge> {fmtTime(r.at)} ({r.trigger}{r.latencyMs !== null ? `, ${r.latencyMs} ms` : ''}): {r.message}</li>
                  ))}</ul>
                )}
              </div>
            </div>
          ))}
          {msg && <p className="text-ink" role="status">{msg}</p>}
          <p className="text-[13px] text-grey-h">Setup guide: {data.integration.docs}</p>
        </div>
      )}
    </Sheet>
  )
}

export function IntegrationsScreen() {
  const { data, error, loading, reload } = useLoad(() => storeFetch<ListResponse>('/api/store/integrations'), 'integrations')
  const [advanced, setAdvanced] = useState<IntegrationView['key'] | null>(null)
  const header = <PageHeader title="Integrations" sub="One place for every connection: its status, what Deploi uses it for and what it lets Deploi do. Connecting a tool never lets an agent act: agents get permissions only when you grant them." />
  if (loading && !data) return <>{header}<Loading label="Loading integrations" rows={4} /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const attention = data.integrations.filter(i => i.status === 'needs_reauth' || i.status === 'error')
  return (
    <>
      {header}
      {attention.length > 0 && (
        <Panel tone="warn" className="mt-2"><p className="text-[15px]" data-testid="attention">{attention.length === 1 ? `${attention[0].name} needs your attention.` : `${attention.length} integrations need your attention.`} Reconnecting keeps each connection and the agents that use it.</p></Panel>
      )}
      {GROUPS.map(g => {
        const items = data.integrations.filter(i => i.suite === g.key)
        if (!items.length) return null
        return (
          <Section key={g.key} id={`int-${g.key}`} title={g.title} sub={g.sub}>
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {items.map(i => <IntegrationCard key={i.key} i={i} onChanged={reload} onAdvanced={() => setAdvanced(i.key)} />)}
            </ul>
          </Section>
        )
      })}
      {advanced && <DiagnosticsSheet keyName={advanced} onClose={() => setAdvanced(null)} />}
      <p className="pt-6 text-[13px] text-grey-h">&ldquo;Connected&rdquo; means Deploi holds a working connection for your organization; Deploi checks each one every hour. &ldquo;Needs reconnecting&rdquo; means the provider no longer accepts it. &ldquo;Not available yet&rdquo; means it is not switched on in this deployment.</p>
    </>
  )
}
