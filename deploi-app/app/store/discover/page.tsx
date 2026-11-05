'use client'
/**
 * Business discovery (functional first-run screen; the visual design lives with the UI workstream).
 * Shows only what discovery really found for this organization: cases, the profile with its sources, and
 * the recommended team. Set up creates the team at drafts only; "Grant all shown" grants exactly the
 * versions shown on this screen (each by its hash), nothing else.
 */
import { useState } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading } from '@/components/store/bits'
import type { DiscoverView } from '@/lib/discovery'

type Summary = { grants: string[]; limits: string[]; never: string[] }
type ViewResponse = DiscoverView & { ok: true }
type GrantResponse = { results: { agentId: string; ok: boolean; message?: string }[]; granted: number; refused: number }

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '')

function SummaryView({ s }: { s: Summary }) {
  return (
    <div className="text-sm" data-testid="policy-summary">
      {s.grants.length > 0 && <p><strong>Allowed:</strong> {s.grants.join('; ')}</p>}
      {s.limits.length > 0 && <p><strong>Limits:</strong> {s.limits.join('; ')}</p>}
      {s.never.length > 0 && <p><strong>Never:</strong> {s.never.join('; ')}</p>}
    </div>
  )
}

export default function DiscoverPage() {
  const { data, error, loading, reload, setData } = useLoad(() => storeFetch<ViewResponse>('/api/store/discover'), 'discover')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null)

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label); setNote(null)
    try { await fn() } catch (e) { setNote({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(null) }
  }
  const discover = () => act('discover', async () => {
    const r = await storeFetch<{ view: DiscoverView }>('/api/store/discover', { method: 'POST', body: {} })
    setData({ ok: true, ...r.view })
  })
  const setUp = () => act('team', async () => {
    const r = await storeFetch<{ items: { name: string; status: string; message: string | null }[] }>('/api/store/discover/team', { method: 'POST', body: { op: 'create' } })
    const blocked = r.items.filter(i => i.status === 'blocked' || i.status === 'failed' || i.status === 'manual')
    if (blocked.length) setNote({ tone: 'info', text: blocked.map(i => `${i.name}: ${i.message ?? i.status}`).join(' ') })
    await reload()
  })
  const shown = (data?.team ?? []).filter(t => t.agent?.pending?.draftsOnly)
  const grantAll = () => act('grant', async () => {
    const r = await storeFetch<GrantResponse>('/api/store/discover/team', { method: 'POST', body: { op: 'grant', grants: shown.map(t => ({ agentId: t.agent!.agentId, policyId: t.agent!.pending!.policyId, policyHash: t.agent!.pending!.policyHash })) } })
    setNote(r.refused ? { tone: 'warn', text: `${r.granted} granted; ${r.refused} not granted: ${r.results.filter(x => !x.ok).map(x => x.message).join(' ')}` } : { tone: 'info', text: `${r.granted} ${r.granted === 1 ? 'agent is' : 'agents are'} now working, at drafts only.` })
    await reload()
  })

  if (loading && !data) return <><PageHeader title="Business discovery" /><Loading label="Loading discovery" /></>
  if (error && !data) return <><PageHeader title="Business discovery" /><ErrorState error={error} onRetry={reload} /></>
  const v = data!
  const found = v.findings.total > 0
  const notCreated = v.team.filter(t => !t.agent && t.setup === 'automatic')

  return (
    <>
      <PageHeader
        title={found ? 'We found work your AI team can handle.' : 'Business discovery'}
        sub="Deploi reads only what you connected, lists what it found, and recommends agents. Nothing changes and nothing is sent until you approve it."
        actions={<Button variant={found ? 'ghost' : 'primary'} onClick={discover} disabled={busy !== null || v.running}>{busy === 'discover' || v.running ? 'Discovering…' : v.run ? 'Run discovery again' : 'Discover my business'}</Button>}
      />
      {note && <Banner tone={note.tone}>{note.text}</Banner>}
      {v.run && (
        <p className="text-sm" data-testid="run-status">
          Last run: {v.run.status}{v.run.finished_at ? `, ${when(v.run.finished_at)}` : ''}{v.run.status_reason ? `. ${v.run.status_reason}` : ''}
        </p>
      )}

      <section aria-label="What we found">
        <h2>What we found</h2>
        {!v.run && <Empty title="Nothing discovered yet">{v.connected ? 'Run discovery to see what your AI team can handle.' : 'Connect your store, CRM or mailbox first; discovery reads only what you connect.'}</Empty>}
        {v.run && !found && <Empty title="Nothing needs attention right now">Discovery read what you connected and found no problems it can work on.</Empty>}
        {found && (
          <ul data-testid="findings">
            {v.findings.cases.map(c => (
              <li key={c.id}>
                <Badge tone={c.priority === 'high' || c.priority === 'urgent' ? 'warn' : 'muted'}>{c.priority}</Badge>{' '}
                <span>{c.ref}</span> {c.title} <Badge tone="muted">{c.status}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      {v.team.length > 0 && (
        <section aria-label="Recommended AI team">
          <h2>Your recommended AI team</h2>
          <ul data-testid="team">
            {v.team.map(t => (
              <li key={t.template} data-template={t.template}>
                <h3>{t.name} {t.agent ? <Badge tone={t.agent.status === 'active' ? 'ok' : 'muted'}>{t.agent.status === 'active' ? 'working' : 'waiting for your grant'}</Badge> : null}</h3>
                <p>{t.reason}</p>
                {t.monitors && <p className="text-sm"><strong>Monitors:</strong> {t.monitors}</p>}
                {t.schedule && <p className="text-sm"><strong>Schedule:</strong> {t.schedule}</p>}
                <p className="text-sm"><strong>Approval:</strong> {t.approval}</p>
                {t.limits.length > 0 && <p className="text-sm"><strong>Safe limits:</strong> {t.limits.join('; ')}</p>}
                {t.needs.length > 0 && <p className="text-sm"><strong>Still needed from you:</strong> {t.needs.join('; ')}</p>}
                {t.agent?.pending && <SummaryView s={t.agent.pending.summary} />}
              </li>
            ))}
          </ul>
          {notCreated.length > 0 && <Button onClick={setUp} disabled={busy !== null}>{busy === 'team' ? 'Setting up…' : 'Set up recommended team'}</Button>}
          {shown.length > 0 && <Button onClick={grantAll} disabled={busy !== null}>{busy === 'grant' ? 'Granting…' : `Grant all shown (${shown.length})`}</Button>}
        </section>
      )}

      {v.profile && (
        <section aria-label="Business profile">
          <h2>Your business, as read</h2>
          <ul data-testid="profile">
            {v.profile.platforms.map(p => <li key={`${p.app}:${p.label}`}>{p.label}: {p.status}{p.synthetic ? ' (test data)' : ''}</li>)}
            {v.profile.facts.map(f => <li key={f.key}>{f.label}: {f.capped ? 'at least ' : ''}{String(f.value)} <span className="text-sm">({f.source}, {when(f.observedAt)})</span></li>)}
          </ul>
          {v.profile.notRead.length > 0 && <ul data-testid="not-read">{v.profile.notRead.map(n => <li key={`${n.app}:${n.label}`} className="text-sm">{n.reason}</li>)}</ul>}
        </section>
      )}
    </>
  )
}
