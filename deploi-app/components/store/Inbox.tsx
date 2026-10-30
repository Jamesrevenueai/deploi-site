'use client'
/**
 * Approval inbox (/store/inbox): every exact change and email an agent is waiting on you for.
 * Approve runs the change now (re-read, write, verify) or sends the exact message; Reject closes it.
 * Drafts from drafts-only agents can only be rejected: those agents may never make changes.
 */
import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Icon } from '@/components/ui/Icon'
import { storeFetch, asApiError, type StoreApiError } from './api'
import { useLoad } from './useLoad'
import { ErrorState, Loading, Panel, Section, SeverityBadge, useStore } from './bits'
import { EMAIL_TASK_SHORT, changeInWords, fmtTime, fmtUntil } from './format'

type Change = { id: string; issue_id: string; agent_id: string; agent_name: string; target_label: string | null; summary: string | null; severity: string; change: { field: string; from: unknown; to: unknown }; change_hash: string; expires_at: string; created_at: string; kind: 'draft' | 'approval'; why: string }
type Email = { id: string; agent_id: string | null; agent_name: string | null; status: string; status_reason: string | null; subject: string | null; to_addresses: string[]; created_at: string; content_hash: string; task_key?: string }
type InboxResponse = { ok: true; changes: Change[]; emails: Email[] }

export function InboxScreen() {
  const { base } = useStore()
  const { data, error, loading, reload } = useLoad(() => storeFetch<InboxResponse>('/api/store/inbox'), 'inbox')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [err, setErr] = useState<StoreApiError | null>(null)

  async function act(key: string, fn: () => Promise<string>) {
    setBusy(key); setErr(null); setNote(null)
    try { const text = await fn(); setNote({ ok: /^(Approved: .*(Verified|accepted by the provider)|Rejected:)/.test(text), text }) } catch (e) { setErr(asApiError(e)) } finally { setBusy(null); await reload() }
  }
  const approveChange = (c: Change) => act(`a:${c.id}`, async () => { const r = await storeFetch<{ status: string }>(`/api/store/proposals/${c.id}/approve`, { method: 'POST', body: { changeHash: c.change_hash } }); return `Approved: ${c.target_label ?? 'change'} ended ${r.status === 'verified' ? 'Verified (confirmed by a fresh read)' : r.status}.` })
  const rejectChange = (c: Change) => act(`r:${c.id}`, async () => { await storeFetch(`/api/store/issues/${c.issue_id}/dismiss`, { method: 'POST', body: { note: 'rejected in the approval inbox' } }); return `Rejected: ${c.target_label ?? 'change'} will not be made.` })
  const approveEmail = (m: Email) => act(`ea:${m.id}`, async () => { const r = await storeFetch<{ status: string }>(`/api/store/email/messages/${m.id}/approve`, { method: 'POST', body: { contentHash: m.content_hash } }); return `Approved: "${m.subject ?? 'message'}" is ${r.status === 'accepted' ? 'accepted by the provider' : r.status.replace('_', ' ')}.` })
  const rejectEmail = (m: Email) => act(`er:${m.id}`, async () => { await storeFetch(`/api/store/email/messages/${m.id}/decline`, { method: 'POST', body: {} }); return `Rejected: "${m.subject ?? 'message'}" will not be sent.` })

  const header = <PageHeader title="Approvals" sub="Everything your agents are waiting on you for. Approving makes that exact change or sends that exact message, nothing else. Rejecting closes it. Drafts from drafts-only agents can only be rejected." />
  if (loading && !data) return <>{header}<Loading label="Loading approvals" /></>
  if (error && !data) return <>{header}<ErrorState error={error} onRetry={reload} /></>
  const d = data!
  const approvals = d.changes.filter(c => c.kind === 'approval'), drafts = d.changes.filter(c => c.kind === 'draft')
  const emailWaiting = d.emails.filter(m => m.status === 'awaiting_approval'), emailDrafts = d.emails.filter(m => m.status === 'draft')

  return (
    <>
      {header}
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone={approvals.length ? 'warn' : 'muted'}>{approvals.length} change{approvals.length === 1 ? '' : 's'} to approve</Badge>
        <Badge tone={emailWaiting.length ? 'warn' : 'muted'}>{emailWaiting.length} email{emailWaiting.length === 1 ? '' : 's'} to approve</Badge>
        <Badge tone="muted">{drafts.length + emailDrafts.length} draft{drafts.length + emailDrafts.length === 1 ? '' : 's'}</Badge>
      </div>
      <div aria-live="polite" className="mb-3 flex flex-col gap-3">
        {note && <Banner tone={note.ok ? 'info' : 'warn'} icon={note.ok ? 'check' : 'alert'}>{note.text}</Banner>}
        {err && <ErrorState error={err} />}
      </div>

      <Section id="changes" title="Store changes to approve" sub="Approving re-reads the record, makes this one change, and confirms it with a fresh read.">
        {approvals.length === 0 ? <Empty title="Nothing to approve">No store changes are waiting for you.</Empty> : (
          <ul className="flex flex-col gap-3">{approvals.map(c => <ChangeItem key={c.id} c={c} base={base} busy={busy} onApprove={() => approveChange(c)} onReject={() => rejectChange(c)} />)}</ul>
        )}
      </Section>

      <Section id="emails" title="Emails to approve" sub="The exact sender, recipients, subject and body were fixed when the agent wrote it. Approving sends that exact message.">
        {emailWaiting.length === 0 ? <Empty title="Nothing to approve">No emails are waiting for you.</Empty> : (
          <ul className="flex flex-col gap-3">{emailWaiting.map(m => <EmailItem key={m.id} m={m} base={base} busy={busy} onApprove={() => approveEmail(m)} onReject={() => rejectEmail(m)} />)}</ul>
        )}
      </Section>

      <Section id="drafts" title="Drafts (not made, not sent)" sub="From agents that are drafts only. They show you exactly what they would do. To let an agent act, widen it and grant the new version.">
        {drafts.length + emailDrafts.length === 0 ? <Empty title="No drafts">Drafts appear here after a drafts-only agent runs.</Empty> : (
          <ul className="flex flex-col gap-3">
            {drafts.map(c => <ChangeItem key={c.id} c={c} base={base} busy={busy} onReject={() => rejectChange(c)} />)}
            {emailDrafts.map(m => <EmailItem key={m.id} m={m} base={base} busy={busy} onReject={() => rejectEmail(m)} />)}
          </ul>
        )}
      </Section>
    </>
  )
}

function ChangeItem({ c, base, busy, onApprove, onReject }: { c: Change; base: string; busy: string | null; onApprove?: () => void; onReject: () => void }) {
  const cw = changeInWords(c.change)
  return (
    <li>
      <Panel>
        <div className="flex flex-wrap items-center gap-2">
          {c.kind === 'draft' ? <Badge tone="muted">Draft: not made</Badge> : <Badge tone="warn">Waiting for you</Badge>}
          <SeverityBadge severity={c.severity} />
          <span className="min-w-0 break-words font-medium text-ink">{c.target_label ?? 'Record'}</span>
        </div>
        <p className="pt-1 text-[13px] text-grey-h">From <Link href={`${base}/agents/${c.agent_id}`} className="text-ink underline">{c.agent_name}</Link> · {fmtTime(c.created_at)}</p>
        {c.summary && <p className="pt-2 text-[15px] text-grey">{c.summary}</p>}
        <div className="mt-3 rounded-[14px] border border-line bg-[#0A0A0A] p-3">
          <div className="text-[13px] text-grey-h">{cw.label}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[1.05rem] font-semibold text-ink break-all"><span>{cw.from}</span><Icon name="arrow-right" size={16} /><span>{cw.to}</span></div>
        </div>
        <p className="pt-2 text-[14px] text-grey"><span className="text-grey-h">Why it is here: </span>{c.why}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {onApprove && <Button size="sm" onClick={onApprove} disabled={busy !== null} aria-label={`Approve ${c.target_label ?? 'change'}`}><Icon name="check" size={15} />{busy === `a:${c.id}` ? 'Re-read, write, verify…' : 'Approve'}</Button>}
          <Button size="sm" variant="ghost" onClick={onReject} disabled={busy !== null} aria-label={`Reject ${c.target_label ?? 'change'}`}>{busy === `r:${c.id}` ? 'Rejecting…' : 'Reject'}</Button>
          <span className="text-[13px] text-grey-h">Expires {fmtUntil(c.expires_at)}</span>
        </div>
      </Panel>
    </li>
  )
}

function EmailItem({ m, base, busy, onApprove, onReject }: { m: Email; base: string; busy: string | null; onApprove?: () => void; onReject: () => void }) {
  return (
    <li>
      <Panel>
        <div className="flex flex-wrap items-center gap-2">
          {m.status === 'draft' ? <Badge tone="muted">Draft: not sent</Badge> : <Badge tone="warn">Waiting for you</Badge>}
          <Badge tone="muted">{EMAIL_TASK_SHORT[m.task_key ?? ''] ?? 'Email'}</Badge>
          <span className="min-w-0 break-words font-medium text-ink">{m.subject ?? '(subject hidden)'}</span>
        </div>
        <p className="pt-1 text-[13px] text-grey-h">{m.agent_id ? <>From <Link href={`${base}/agents/${m.agent_id}#email`} className="text-ink underline">{m.agent_name}</Link> · </> : null}To {m.to_addresses.join(', ')} · {fmtTime(m.created_at)}</p>
        {m.status_reason && <p className="pt-2 text-[14px] text-grey"><span className="text-grey-h">Why it is here: </span>{m.status_reason}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {onApprove && <Button size="sm" onClick={onApprove} disabled={busy !== null} aria-label={`Approve and send ${m.subject ?? 'message'}`}><Icon name="check" size={15} />{busy === `ea:${m.id}` ? 'Sending…' : 'Approve and send'}</Button>}
          <Button size="sm" variant="ghost" onClick={onReject} disabled={busy !== null} aria-label={`Reject ${m.subject ?? 'message'}`}>{busy === `er:${m.id}` ? 'Rejecting…' : 'Reject'}</Button>
          {m.agent_id && <Link href={`${base}/agents/${m.agent_id}#email`} className="text-[13px] text-ink underline">Read the full message</Link>}
        </div>
      </Panel>
    </li>
  )
}
