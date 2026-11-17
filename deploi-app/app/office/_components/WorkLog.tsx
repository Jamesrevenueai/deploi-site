'use client'
/** Work log: every office action, its outcome, who or what allowed it and under which permission version. */
import { PageHeader } from '@/components/ui/PageHeader'
import { Empty } from '@/components/ui/Empty'
import { storeFetch } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, Panel, Section } from '@/components/store/bits'
import { StatusBadge, fmt } from './shared'

type Row = { id: string; kind: string; purpose: string; status: string; status_reason: string | null; approval_kind: string | null; approved_by: string | null; policy_version: number | null; what: string; verified_at: string | null; updated_at: string; agent_name: string }
type Ev = { id: string; at: string; event: string; actor: string }

export function WorkLogScreen() {
  const { data, error, loading, reload } = useLoad(() => storeFetch<{ actions: Row[]; events: Ev[] }>('/api/office/log'), 'office-log')
  const header = <PageHeader title="Work log" sub="What each office agent did, when, why it was allowed, and whether a fresh read confirmed it." />
  if (loading && !data) return <>{header}<Loading /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  const d = data!
  return (
    <>
      {header}
      <Section title="Actions">
        {d.actions.length === 0 ? <Empty title="Nothing yet" /> : <ul className="flex flex-col gap-2">{d.actions.map(a => (
          <li key={a.id}><Panel>
            <div className="flex flex-wrap items-center justify-between gap-2"><span>{a.agent_name}: {a.purpose}</span><StatusBadge status={a.status} /></div>
            <div className="pt-1 text-[14px] text-grey break-words">{a.what}</div>
            <div className="pt-1 text-[13px] text-grey-h">{fmt(a.updated_at)} · {a.approval_kind === 'standing' ? 'within the standing permission' : a.approval_kind === 'individual' ? `approved by ${a.approved_by}` : 'not approved'} · version {a.policy_version ?? '—'}{a.verified_at ? ' · confirmed by a fresh read' : ''}{a.status_reason ? ` · ${a.status_reason}` : ''}</div>
          </Panel></li>
        ))}</ul>}
      </Section>
      <Section title="Audit trail">
        {d.events.length === 0 ? <Empty title="No events" /> : <ul className="flex flex-col gap-1 text-[13px]">{d.events.map(e => <li key={e.id} className="text-grey"><span className="text-grey-h">{fmt(e.at)}</span> {e.event.replace(/^office\./, '')} · {e.actor}</li>)}</ul>}
      </Section>
    </>
  )
}
