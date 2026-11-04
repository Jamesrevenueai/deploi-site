'use client'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Empty } from '@/components/ui/Empty'
import { storeFetch } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading, Panel, Section } from '@/components/store/bits'
import { StatusBadge, fmt } from './shared'

type Overview = { leadsInFollowup: number; leadsReplied: number; meetingsBooked: number; pendingApprovals: number; drafts: number; agents: number
  recent: { id: string; kind: string; purpose: string; status: string; status_reason: string | null; updated_at: string; agent_name: string }[] }

export function OverviewScreen() {
  const { data, error, loading, reload } = useLoad(() => storeFetch<Overview>('/api/office/overview'), 'office-overview')
  const header = <PageHeader title="Office" sub="Your office agents at a glance. Everything they send, book or write to HubSpot is listed in the work log with the permission that allowed it." />
  if (loading && !data) return <>{header}<Loading /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  const d = data!
  const tiles: [string, number, string][] = [['Leads in follow-up', d.leadsInFollowup, '/office/agents'], ['Leads who replied', d.leadsReplied, '/office/agents'], ['Meetings booked', d.meetingsBooked, '/office/log'], ['Waiting for your approval', d.pendingApprovals, '/office/approvals']]
  return (
    <>
      {header}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map(([label, n, href]) => (
          <Link key={label} href={href}><Panel><div className="text-[28px] text-ink">{n}</div><div className="text-[14px] text-grey-h">{label}</div></Panel></Link>
        ))}
      </div>
      {d.agents === 0 && <div className="mt-6"><Empty title="No office agents yet">Connect HubSpot, Google Calendar and a mailbox in <Link className="underline" href="/office/connections">Connections</Link>, then create an agent from a template in <Link className="underline" href="/office/agents">Agents</Link>.</Empty></div>}
      <Section title="Recent actions" sub={`${d.drafts} draft${d.drafts === 1 ? '' : 's'} from drafts-only agents are in Approvals.`}>
        {d.recent.length === 0 ? <Empty title="Nothing yet">Actions appear here as agents work.</Empty> : (
          <ul className="flex flex-col gap-2">{d.recent.map(r => (
            <li key={r.id}><Panel><div className="flex flex-wrap items-center justify-between gap-2"><span>{r.agent_name}: {r.purpose}</span><StatusBadge status={r.status} /></div>
              <div className="pt-1 text-[13px] text-grey-h">{fmt(r.updated_at)}{r.status_reason ? ` · ${r.status_reason}` : ''}</div></Panel></li>
          ))}</ul>
        )}
      </Section>
    </>
  )
}
