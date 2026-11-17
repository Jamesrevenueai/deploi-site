'use client'
/** Case pieces shared by Home, Work in Progress, Needs My Approval, Completed Work and the case page. */
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { storeFetch, asApiError, type StoreApiError } from '@/components/store/api'
import { ErrorState } from '@/components/store/bits'
import { fmtAgo, fmtTime } from '@/components/store/format'
import { caseHref } from '@/lib/store/nav'
import { PRIORITY_WORDS, STATUS_WORDS, SUITE_LABEL, agentLabel, approvalContentRows, humanize, sourceAppLabel, type AgentDirectory, type ApprovalEntry, type CaseItem } from './caseView'

export function CaseStatusBadge({ status }: { status: CaseItem['status'] }) {
  const w = STATUS_WORDS[status] ?? { label: humanize(status), tone: 'muted' as const }
  return <span data-case-status={status}><Badge tone={w.tone}>{w.label}</Badge></span>
}
export function PriorityBadge({ priority }: { priority: CaseItem['priority'] }) {
  if (priority === 'normal' || priority === 'low') return null
  const w = PRIORITY_WORDS[priority]
  return <Badge tone={w.tone}>{w.label} priority</Badge>
}

/** One case as a row in a list: what it is, where it was found, who owns it, where it stands. */
export function CaseRowCard({ c, dir }: { c: CaseItem; dir: AgentDirectory }) {
  const agent = agentLabel(dir, c.agent_kind, c.agent_ref)
  return (
    <li data-case={c.ref}>
      <Link href={caseHref(c.ref)} className="panel block p-4 transition-colors hover:border-[var(--c-accent-line)] md:p-5" aria-label={`${c.title} (${c.ref})`}>
        <div className="flex flex-wrap items-center gap-2">
          <CaseStatusBadge status={c.status} />
          <PriorityBadge priority={c.priority} />
          <span className="text-[12.5px] text-grey-h">{c.ref} · {SUITE_LABEL[c.suite]} · {sourceAppLabel(c.source_app)}</span>
        </div>
        <div className="mt-2 break-words text-[16px] font-semibold text-ink">{c.title}</div>
        <p className="mt-1 line-clamp-2 text-[14px] text-grey">{c.status === 'resolved' && c.outcome ? c.outcome.summary : c.why_it_matters ?? c.problem}</p>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-grey-h">
          <span><Icon name="users" size={13} className="mr-1 inline" />{agent ? agent.name : 'Not assigned yet'}</span>
          {c.status === 'resolved' && c.outcome ? <span><Icon name="check" size={13} className="mr-1 inline" />Verified {fmtAgo(c.outcome.verifiedAt)} by {c.outcome.verifiedBy}</span>
            : c.next_action ? <span className="min-w-0 break-words"><Icon name="arrow-right" size={13} className="mr-1 inline" />Next: {c.next_action}</span> : null}
          <span>Updated {fmtAgo(c.updated_at)}</span>
        </div>
      </Link>
    </li>
  )
}

export function CaseList({ cases, dir, label, empty }: { cases: CaseItem[]; dir: AgentDirectory; label: string; empty: ReactNode }) {
  if (!cases.length) return <>{empty}</>
  return <ul className="flex flex-col gap-3" aria-label={label}>{cases.map(c => <CaseRowCard key={c.id} c={c} dir={dir} />)}</ul>
}

const SOURCE_WORDS: Record<string, string> = { engine: 'Store change', email: 'Email', library: 'Agent action', office: 'Office', case: 'Case decision' }

/**
 * One decision with the exact content it covers, and Approve / Reject through the approvals API.
 * The decision carries the version (content hash) shown here; a changed item is refused as stale.
 */
export function ApprovalCard({ item, onDone, caseRef }: { item: ApprovalEntry; onDone: (msg: string) => void | Promise<void>; caseRef?: string | null }) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null)
  const [err, setErr] = useState<StoreApiError | null>(null)
  const rows = approvalContentRows(item.content)
  async function decide(d: 'approve' | 'reject') {
    setBusy(d); setErr(null)
    try {
      const r = await storeFetch<{ status: string; reason?: string | null }>(`/api/store/approvals/${encodeURIComponent(item.source)}/${item.id}/${d}`, { method: 'POST', body: { version: item.version } })
      await onDone(d === 'approve' ? `Approved: ${item.title}. Result: ${humanize(r.status)}${r.reason ? ` (${r.reason})` : ''}.` : `Rejected: ${item.title}. Nothing was done.`)
    } catch (e) { setErr(asApiError(e)) } finally { setBusy(null) }
  }
  return (
    <article className="panel p-4 md:p-5" data-approval={`${item.source}:${item.id}`} aria-label={item.title}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warn">Needs your decision</Badge>
        <Badge tone="muted">{SOURCE_WORDS[item.source] ?? humanize(item.source)}</Badge>
        {caseRef && <Link href={caseHref(caseRef)} className="text-[13px] link">{caseRef}</Link>}
        <span className="text-[12.5px] text-grey-h">{fmtAgo(item.createdAt)}{item.expiresAt ? ` · expires ${fmtTime(item.expiresAt)}` : ''}</span>
      </div>
      <h3 className="mt-2 break-words text-[16px]">{item.title}</h3>
      {item.agent?.name && <p className="mt-1 text-[13px] text-grey-h">From {item.agent.name}</p>}
      {item.why && <p className="mt-1 text-[14px] text-grey">{item.why}</p>}
      {rows.length > 0 && (
        <div className="mt-3 rounded-[12px] border border-line bg-sunken p-3">
          <div className="eyebrow mb-2">Exactly what you are deciding</div>
          <dl className="kv">
            {rows.map(r => <div key={r.label} className="contents"><dt>{r.label}</dt><dd className="whitespace-pre-wrap">{r.value}</dd></div>)}
          </dl>
        </div>
      )}
      {err && <div className="mt-3"><ErrorState error={err} /></div>}
      {item.decisions.length === 0 ? <p className="mt-3 text-[13px] text-grey-h">View only.</p> : (
        <div className="mt-4 flex flex-wrap gap-2">
          {item.decisions.includes('approve') && <Button size="sm" onClick={() => decide('approve')} disabled={busy !== null}><Icon name="check" size={15} />{busy === 'approve' ? 'Approving…' : 'Approve'}</Button>}
          {item.decisions.includes('reject') && <Button size="sm" variant="ghost" onClick={() => decide('reject')} disabled={busy !== null}><Icon name="x" size={15} />{busy === 'reject' ? 'Rejecting…' : 'Reject'}</Button>}
        </div>
      )}
      {!item.decisions.includes('approve') && item.decisions.includes('reject') && <p className="mt-2 text-[13px] text-grey-h">This agent works at drafts only, so this can only be rejected.</p>}
    </article>
  )
}

export function Notice({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null
  return <Banner tone={msg.ok ? 'info' : 'warn'} icon={msg.ok ? 'check' : 'alert'}>{msg.text}</Banner>
}
