'use client'
/**
 * The case page (/store/work/[ref]), the same for every kind of case: what Deploi discovered, why it matters,
 * which agent owns it, the actions taken, the evidence, the decisions waiting (approve here, exact content
 * shown), the next steps, and the final verification (outcome and the evidence that confirmed it).
 */
import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Icon } from '@/components/ui/Icon'
import { storeFetch } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading } from '@/components/store/bits'
import { fmtTime, fmtAgo } from '@/components/store/format'
import { ApprovalCard, CaseStatusBadge, Notice, PriorityBadge } from './bits'
import { loadApprovals, loadTeam, directoryOf } from './data'
import { STATUS_WORDS, SUITE_LABEL, agentLabel, caseActions, caseTimeline, humanize, pendingDecisionsFor, sourceAppLabel, type CaseEvidence, type CaseResponse } from './caseView'

function Block({ id, title, children, icon }: { id: string; title: string; children: React.ReactNode; icon: string }) {
  return (
    <section className="panel p-4 md:p-5" id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="mb-3 flex items-center gap-2 text-[16px]"><Icon name={icon} size={17} className="text-accent" />{title}</h2>
      {children}
    </section>
  )
}

function EvidenceList({ items, empty }: { items: CaseEvidence[]; empty: string }) {
  if (!items.length) return <p className="text-[14px] text-grey-h">{empty}</p>
  return (
    <ul className="flex flex-col gap-2" aria-label="Evidence">
      {items.map((e, i) => (
        <li key={i} className="rounded-[12px] border border-line bg-sunken p-3 text-[14px]">
          <div className="break-words text-ink">{e.label}</div>
          <div className="pt-1 text-[12.5px] text-grey-h">{sourceAppLabel(e.source)} · observed {fmtTime(e.observedAt)}{e.ref ? ` · ${humanize(e.ref.type)}` : ''}</div>
        </li>
      ))}
    </ul>
  )
}

/** Close a case yourself (cancelled with your reason, never marked resolved). Only for kinds that allow it. */
function CloseBlock({ caseRef, kind, close, onDone, onError }: { caseRef: string; kind: string; close: { label: string; needsReason: boolean }; onDone: (text: string) => Promise<void>; onError: (text: string) => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const info = kind === 'market_signal'
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await storeFetch(`/api/store/cases/${encodeURIComponent(caseRef)}`, { method: 'POST', body: close.needsReason ? { reason } : {} })
      await onDone(info ? 'Acknowledged. The case is closed; it is not counted as resolved work.' : 'Closed with your reason. It is not counted as resolved work.')
    } catch (err) { onError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <Block id="close" title={info ? 'For your information' : 'Close it yourself'} icon="check">
      <form onSubmit={submit} className="flex flex-col gap-2" aria-label={close.label}>
        <p className="text-[13.5px] text-grey">{info ? 'Nothing needs fixing. Acknowledge it once you have read it.' : 'If this is no longer needed, close it and say why. It is recorded as closed by you, not as resolved.'}</p>
        {close.needsReason && <label className="text-[13px] text-grey-h">Reason<textarea className="input mt-1 w-full" rows={2} maxLength={500} required value={reason} onChange={e => setReason(e.target.value)} /></label>}
        <div><button type="submit" className="btn" disabled={busy || (close.needsReason && !reason.trim())}>{close.label}</button></div>
      </form>
    </Block>
  )
}

export function CaseDetailScreen({ caseRef }: { caseRef: string }) {
  const { data, error, loading, reload } = useLoad(async () => {
    const [c, approvals, team] = await Promise.all([storeFetch<CaseResponse>(`/api/store/cases/${encodeURIComponent(caseRef)}`), loadApprovals().catch(() => null), loadTeam()])
    return { ...c, approvals, dir: directoryOf(team) }
  }, `case-${caseRef}`)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  if (loading && !data) return <><PageHeader eyebrow={<Link href="/store/work" className="link">Work in Progress</Link>} title="Case" /><Loading label="Loading the case" rows={4} /></>
  if (error && !data) return <><PageHeader eyebrow={<Link href="/store/work" className="link">Work in Progress</Link>} title="Case" /><ErrorState error={error} onRetry={reload} /></>
  if (!data) return null
  const c = data.case
  const words = STATUS_WORDS[c.status]
  const agent = agentLabel(data.dir, c.agent_kind, c.agent_ref)
  const decisions = pendingDecisionsFor(c, data.events, data.approvals?.items ?? [])
  const actions = caseActions(data.events)
  const timeline = caseTimeline(data.events)
  const open = !['resolved', 'cancelled'].includes(c.status)
  const back = words.stage === 'done' ? { href: '/store/completed', label: 'Completed Work' } : c.status === 'awaiting_approval' ? { href: '/store/approvals', label: 'Needs My Approval' } : { href: '/store/work', label: 'Work in Progress' }

  return (
    <div data-case-page={c.ref} data-status={c.status}>
      <PageHeader eyebrow={<Link href={back.href} className="link">← {back.label}</Link>} title={c.title} sub={<span className="flex flex-wrap items-center gap-2 text-[14px]"><CaseStatusBadge status={c.status} /><PriorityBadge priority={c.priority} /><span className="text-grey-h">{c.ref} · {SUITE_LABEL[c.suite]} · found in {sourceAppLabel(c.source_app)} · opened {fmtTime(c.opened_at)}</span></span>} />
      <div aria-live="polite" className="mb-4 flex flex-col gap-3">
        <Notice msg={msg} />
        {c.status_reason && open && <Banner tone={words.stage === 'attention' ? 'warn' : 'info'} icon={words.stage === 'attention' ? 'alert' : 'clock'}><strong>{words.label}.</strong> {c.status_reason}</Banner>}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Block id="discovered" title="What Deploi discovered" icon="search">
            <p className="whitespace-pre-wrap break-words text-[15px] text-ink">{c.problem}</p>
            {c.records.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{c.records.map(r => <Badge key={`${r.type}:${r.id}`} tone="muted">{humanize(r.type)}: {r.label ?? r.id}</Badge>)}</div>}
          </Block>
          <Block id="why" title="Why it matters" icon="alert">
            <p className="whitespace-pre-wrap break-words text-[15px] text-grey">{c.why_it_matters ?? 'Not stated for this case.'}</p>
          </Block>

          <Block id="decisions" title="Decisions waiting for you" icon="check">
            {decisions.length > 0 ? (
              <div className="flex flex-col gap-3">{decisions.map(a => <ApprovalCard key={`${a.source}:${a.id}`} item={a} onDone={async text => { setMsg({ ok: true, text }); await reload() }} />)}</div>
            ) : c.status === 'awaiting_approval' ? (
              <p className="text-[14px] text-grey">This case waits for your decision. <Link href="/store/approvals" className="link">Open Needs My Approval</Link> to see it.</p>
            ) : <p className="text-[14px] text-grey-h">Nothing is waiting for you on this case.</p>}
          </Block>

          <Block id="actions" title="Actions taken" icon="bolt">
            {actions.length ? (
              <ul className="flex flex-col gap-2" aria-label="Actions taken">{actions.map(a => <li key={a.id} className="rounded-[12px] border border-line p-3 text-[14px]"><div className="break-words text-ink">{a.summary}</div><div className="pt-1 text-[12.5px] text-grey-h">{a.actor} · {fmtTime(a.at)}</div></li>)}</ul>
            ) : <p className="text-[14px] text-grey-h">No action taken yet. {c.approval_required ? 'Your team waits for your decision before acting.' : ''}</p>}
          </Block>

          <Block id="evidence" title="Evidence" icon="file">
            <EvidenceList items={c.evidence} empty="No evidence recorded yet." />
          </Block>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Block id="agent" title="Handled by" icon="users">
            {agent ? <p className="text-[15px]">{agent.href ? <Link href={agent.href} className="link font-medium">{agent.name}</Link> : agent.name}</p> : <p className="text-[14px] text-grey-h">Not assigned to an agent yet.</p>}
            <p className="pt-1 text-[13px] text-grey-h">An agent acts only within the permissions you granted it.</p>
          </Block>
          {open && data.close && <CloseBlock caseRef={c.ref} kind={c.kind} close={data.close} onDone={async text => { setMsg({ ok: true, text }); await reload() }} onError={text => setMsg({ ok: false, text })} />}
          <Block id="next" title="Next steps" icon="arrow-right">
            {open ? (
              <dl className="kv">
                <dt>Next</dt><dd>{c.next_action ?? 'Nothing scheduled'}</dd>
                {c.next_check_at && <><dt>Checks again</dt><dd>{fmtTime(c.next_check_at)}</dd></>}
                {c.deadline_at && <><dt>Deadline</dt><dd>{fmtTime(c.deadline_at)}</dd></>}
                <dt>Attempts</dt><dd>{c.attempts}</dd>
              </dl>
            ) : <p className="text-[14px] text-grey-h">{c.status === 'resolved' ? 'None: this case is resolved.' : 'None: this case was cancelled.'}</p>}
          </Block>
          <Block id="verification" title="Final verification" icon="badge">
            <p className="text-[13px] text-grey-h">Counts as resolved when:</p>
            <p className="pb-3 text-[14px] text-ink">{c.verification?.criteria ?? 'Not stated.'}</p>
            {c.outcome ? (
              <div data-testid="verified-outcome">
                <Badge tone="ok">Verified</Badge>
                <p className="pt-2 text-[15px] text-ink">{c.outcome.summary}</p>
                <p className="pt-1 pb-2 text-[12.5px] text-grey-h">By {c.outcome.verifiedBy} · {fmtTime(c.outcome.verifiedAt)}</p>
                <EvidenceList items={c.outcome.evidence} empty="" />
              </div>
            ) : <Badge tone="muted">{c.status === 'cancelled' ? 'Not resolved: cancelled' : 'Not verified yet'}</Badge>}
          </Block>
          <Block id="history" title="History" icon="clock">
            <ol className="timeline" aria-label="Case history">
              {timeline.map(t => (
                <li key={t.id} data-tone={t.tone}>
                  <div className="text-[14px] font-medium text-ink">{t.title}</div>
                  {t.detail && <div className="break-words text-[13.5px] text-grey">{t.detail}</div>}
                  <div className="text-[12px] text-grey-h">{t.actor} · {fmtAgo(t.at)}</div>
                </li>
              ))}
            </ol>
          </Block>
        </div>
      </div>
    </div>
  )
}
