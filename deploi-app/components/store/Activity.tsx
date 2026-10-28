'use client'
import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'
import { EXECUTION_STATUS_LABEL, PROPOSAL_STATUS_LABEL } from '@/lib/engine/outcomes'
import { storeFetch } from './api'
import { useLoad } from './useLoad'
import { Chips, ErrorState, Loading, OutcomeBadge, Section, useStore } from './bits'
import { actorLabel, changeInWords, fmtTime, shortId } from './format'
import type { ActivityResponse, ExecutionView, ProposalView } from './types'

type Filter = 'all' | 'pending' | 'verified' | 'failed' | 'blocked'

export function ActivityScreen({ initialOutcome }: { initialOutcome?: string }) {
  const [outcome, setOutcome] = useState<Filter>((['pending', 'verified', 'failed', 'blocked'] as const).find(o => o === initialOutcome) ?? 'all')
  const { data, error, loading, reload } = useLoad(
    () => storeFetch<ActivityResponse>(`/api/store/activity${outcome === 'all' ? '' : `?outcome=${outcome}`}`), outcome)

  function change(o: Filter) {
    setOutcome(o)
    try { window.history.replaceState(window.history.state, '', `${window.location.pathname}${o === 'all' ? '' : `?outcome=${o}`}`) } catch { /* convenience only */ }
  }

  return (
    <>
      <PageHeader title="Activity" sub="Every approved change and how it ended. Verified means a fresh read of the store shows the change; anything else is not counted as done." />
      <div className="mb-5">
        <Chips label="Outcome" value={outcome} onChange={change} options={[['pending', 'Pending'], ['verified', 'Verified'], ['failed', 'Failed'], ['blocked', 'Blocked'], ['all', 'All']]} />
      </div>
      {loading && !data ? <Loading label="Loading activity" /> : error && !data ? <ErrorState error={error} onRetry={reload} /> : data && (
        <>
          {error && <div className="mb-4"><ErrorState error={error} onRetry={reload} /></div>}
          {data.executions.length === 0 ? (
            <Empty title={outcome === 'all' ? 'No changes yet' : `No ${outcome} changes`}>Approved changes show up here with their outcome.</Empty>
          ) : (
            <ul className={`flex flex-col gap-3 ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
              {data.executions.map(e => <ExecutionRow key={e.id} e={e} />)}
            </ul>
          )}

          {(outcome === 'all' || outcome === 'blocked') && (
            <Section title="Not run" sub="Proposals that were never run because the store changed, the time limit passed, or something blocked them. Nothing was written for these.">
              {data.blockedProposals.length === 0 ? <Empty title="Nothing here">Every approved proposal has run.</Empty> : (
                <ul className="flex flex-col gap-2">
                  {data.blockedProposals.map(p => <NotRunRow key={p.id} p={p} />)}
                </ul>
              )}
            </Section>
          )}
        </>
      )}
    </>
  )
}

function ExecutionRow({ e }: { e: ExecutionView }) {
  const c = changeInWords(e.change)
  return (
    <li className="rounded-[20px] border border-line p-4 md:p-5 fade-up">
      <div className="flex flex-wrap items-center gap-2">
        <OutcomeBadge outcome={e.outcome} />
        <span className="text-[14px] text-grey">{EXECUTION_STATUS_LABEL[e.status] ?? e.status}</span>
        {e.attempt > 1 && <span className="text-[13px] text-grey-h">attempt {e.attempt}</span>}
        {e.is_synthetic && <Badge tone="warn">Synthetic test store</Badge>}
      </div>
      <div className="mt-2 text-ink font-medium break-words">{e.target_label ?? 'Variant'}</div>
      <div className="text-[15px] text-grey">{c.label}: {c.from} → {c.to}</div>
      <div className="mt-2 flex flex-col gap-0.5 text-[13px] text-grey-h sm:flex-row sm:flex-wrap sm:gap-x-4">
        <span>Approved by {actorLabel(e.approved_by)} · {fmtTime(e.approved_at)}</span>
        <span>{e.finished_at ? `Finished ${fmtTime(e.finished_at)}` : 'Still running'}</span>
      </div>
      {e.status_reason && <p className="pt-1 text-[14px] text-grey break-words">{e.status_reason}</p>}
    </li>
  )
}

function NotRunRow({ p }: { p: ProposalView }) {
  const { base } = useStore()
  const c = changeInWords(p.change)
  return (
    <li className="rounded-[16px] border border-line p-3 md:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <OutcomeBadge outcome={p.outcome} />
        <span className="text-[14px] text-grey">{PROPOSAL_STATUS_LABEL[p.status] ?? p.status}</span>
        <span className="text-[13px] text-grey-h">{fmtTime(p.decided_at ?? p.created_at)}</span>
      </div>
      <Link href={`${base}/issues/${p.issue_id}`} className="mt-1 block font-medium break-words"><span className="text-ink underline-offset-4 hover:underline">{p.target_label ?? shortId(p.target_id)}</span></Link>
      <div className="text-[14px] text-grey">{c.label}: {c.from} → {c.to}</div>
      {p.status_reason && <p className="pt-1 text-[14px] text-grey-h break-words">Reason: {p.status_reason}</p>}
    </li>
  )
}
