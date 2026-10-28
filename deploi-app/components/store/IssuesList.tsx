'use client'
import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'
import { Icon } from '@/components/ui/Icon'
import { OUTCOME_LABEL, PROPOSAL_STATUS_LABEL } from '@/lib/engine/outcomes'
import { storeFetch } from './api'
import { useLoad } from './useLoad'
import { Chips, ErrorState, Loading, NoStore, OutcomeBadge, SeverityBadge, useStore } from './bits'
import { ISSUE_STATUS_LABEL, RESOLUTION_LABEL, fmtAgo } from './format'
import type { IssuesResponse, IssueView, OverviewResponse } from './types'

type Status = 'live' | 'resolved' | 'all'
type Kind = '' | 'correctable' | 'needs_person'

export function IssuesScreen({ initialStatus, initialKind }: { initialStatus?: string; initialKind?: string }) {
  const { base } = useStore()
  const [status, setStatus] = useState<Status>((['live', 'resolved', 'all'] as const).find(s => s === initialStatus) ?? 'live')
  const [kind, setKind] = useState<Kind>((['correctable', 'needs_person'] as const).find(k => k === initialKind) ?? '')
  const { data, error, loading, reload } = useLoad(async () => {
    const qs = new URLSearchParams({ status, ...(kind ? { kind } : {}) })
    const [list, o] = await Promise.all([storeFetch<IssuesResponse>(`/api/store/issues?${qs}`), storeFetch<OverviewResponse>('/api/store/overview')])
    return { issues: list.issues, overview: o }
  }, `${status}:${kind}`)

  function sync(s: Status, k: Kind) {
    try {
      const qs = new URLSearchParams({ ...(s !== 'live' ? { status: s } : {}), ...(k ? { kind: k } : {}) }).toString()
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
    } catch { /* address bar sync is a convenience */ }
  }

  const lastScan = data?.overview.overview.lastScan
  const lastScanText = lastScan ? fmtAgo(lastScan.finished_at ?? lastScan.started_at) : 'not scanned yet'
  const noStore = data && data.overview.connections.length === 0

  return (
    <>
      <PageHeader title="Issues" sub="Problems Deploi found in your store, with the evidence for each. Correctable issues carry an exact change for you to approve." />
      <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div role="tablist" aria-label="Issue status" className="flex gap-1 rounded-full border border-line p-1 self-start">
          {([['live', 'Live'], ['resolved', 'Resolved'], ['all', 'All']] as const).map(([v, l]) => (
            <button key={v} role="tab" type="button" aria-selected={status === v} onClick={() => { setStatus(v); sync(v, kind) }}
              className={`rounded-full px-4 py-1.5 text-[14px] font-medium ${status === v ? 'bg-white text-black' : 'text-grey hover:text-ink'}`}>{l}</button>
          ))}
        </div>
        <Chips label="Issue type" value={kind} onChange={k => { setKind(k); sync(status, k) }} options={[['', 'All types'], ['correctable', 'Correctable'], ['needs_person', 'Needs a person']]} />
      </div>
      <p className="pb-5 text-[13px] text-grey-h">Last scan: {data ? lastScanText : '…'}</p>

      {loading && !data ? <Loading label="Loading issues" /> : error && !data ? <ErrorState error={error} onRetry={reload} /> : noStore ? <NoStore /> : data && (
        <>
          {error && <div className="mb-4"><ErrorState error={error} onRetry={reload} /></div>}
          {data.issues.length === 0 ? (
            <Empty title={status === 'live' ? (kind ? 'No open issues of this type.' : 'No open issues.') : status === 'resolved' ? 'Nothing resolved yet.' : 'No issues yet.'}>
              Last scan: {lastScanText}. {lastScan ? '' : <>Run a scan from the <Link href={base}><span className="underline text-ink">Overview</span></Link>.</>}
            </Empty>
          ) : (
            <ul className={`flex flex-col gap-3 ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
              {data.issues.map(i => <IssueRow key={i.id} i={i} />)}
            </ul>
          )}
        </>
      )}
    </>
  )
}

function IssueRow({ i }: { i: IssueView }) {
  const { base } = useStore()
  const summary = typeof i.evidence.summary === 'string' ? i.evidence.summary : null
  const live = i.status === 'open' || i.status === 'needs_review'
  return (
    <li className="fade-up">
      <Link href={`${base}/issues/${i.id}`} className="block rounded-[20px] border border-line p-4 md:p-5 transition-colors hover:bg-[#0A0A0A]" aria-label={`${i.check_title}: ${i.resource_label ?? i.resource_id}`}>
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={i.severity} />
          <Badge tone={i.status === 'needs_review' ? 'warn' : live ? 'none' : 'muted'}>{ISSUE_STATUS_LABEL[i.status] ?? i.status}</Badge>
          {i.kind === 'needs_person' && <Badge tone="muted">Needs a person</Badge>}
          {i.proposal && i.proposal.outcome !== 'closed' && <span className="inline-flex flex-wrap items-center gap-2"><OutcomeBadge outcome={i.proposal.outcome} />{(PROPOSAL_STATUS_LABEL[i.proposal.status] ?? i.proposal.status) !== OUTCOME_LABEL[i.proposal.outcome] && <span className="text-[13px] text-grey-h">{PROPOSAL_STATUS_LABEL[i.proposal.status] ?? i.proposal.status}</span>}</span>}
          {!live && i.resolution && <span className="text-[13px] text-grey-h">{RESOLUTION_LABEL[i.resolution] ?? i.resolution}</span>}
        </div>
        <div className="mt-2 text-ink font-medium">{i.check_title}</div>
        <div className="text-[15px] text-ink/90 break-words">{i.resource_label ?? i.resource_id}</div>
        {summary && <p className="pt-1 text-[15px] text-grey break-words">{summary}</p>}
        <div className="mt-2 flex items-center justify-between gap-2 text-[13px] text-grey-h">
          <span>Last seen {fmtAgo(i.last_seen_at)}</span>
          <span className="inline-flex items-center gap-1 text-ink">Open<Icon name="arrow-right" size={14} /></span>
        </div>
      </Link>
    </li>
  )
}
