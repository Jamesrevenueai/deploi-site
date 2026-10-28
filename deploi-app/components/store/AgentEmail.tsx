'use client'
/**
 * An agent's email: what its authorization allows, the exact messages waiting for the merchant
 * (sender, recipients, subject, body, attachments), and sent activity with truthful statuses.
 * "Accepted by provider" is the strongest status: providers report acceptance, not delivery.
 */
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Icon } from '@/components/ui/Icon'
import { Input, Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError, StoreApiError } from './api'
import { useLoad } from './useLoad'
import { ErrorState, Facts, Loading, Panel, Section, useStore } from './bits'
import { StatusBadge } from './Agents'
import {
  AGENT_EMAIL_PERMISSION_LABEL, AGENT_EMAIL_TASK_LABEL, EMAIL_ACCEPTED_EXPLAINER, EMAIL_TASK_SHORT, actorLabel, emailAccountWords, emailWords, fmtTime,
} from './format'
import type {
  AgentPolicy, EmailAccountsResponse, EmailAccountView, EmailEditResponse, EmailMessageDetail, EmailMessageItem, EmailMessageResponse, EmailMessagesResponse, EmailSendOutcome,
} from './types'

type Notice = { ok: true; title: string; text: string } | { ok: false; title: string; e: StoreApiError } | null

const CONFLICT: Record<string, string> = {
  hash_mismatch: 'The message changed after this page loaded. Review the current version and approve again.',
  not_pending: 'This message is no longer waiting. Its current state is shown below.',
  agent_inactive: 'The agent is not active. Resume it or grant its authorization first.',
  not_retryable: 'Only failed messages can be retried.',
}
const AUTH_FAILURES = new Set(['auth', 'account', 'token'])
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const fmtBytes = (b: number) => (b < 1024 ? `${b} bytes` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`)

export function AgentEmailSections({ agentId, policy, agentActive, refreshKey, onChanged }: {
  agentId: string; policy: AgentPolicy | null; agentActive: boolean; refreshKey: string; onChanged: () => Promise<void>
}) {
  const { data, error, loading, reload } = useLoad(async () => {
    const [accounts, list] = await Promise.all([
      storeFetch<EmailAccountsResponse>('/api/store/email/accounts').catch(() => null),
      storeFetch<EmailMessagesResponse>(`/api/store/email/messages?agent=${encodeURIComponent(agentId)}`),
    ])
    const open = list.messages.filter(m => m.status === 'awaiting_approval' || m.status === 'draft').slice(0, 25)
    const details = await Promise.all(open.map(m => storeFetch<EmailMessageResponse>(`/api/store/email/messages/${m.id}`).then(r => r.message).catch(() => null)))
    return { accounts: accounts?.accounts ?? [], messages: list.messages, details: details.filter((d): d is EmailMessageDetail => d !== null) }
  }, `email:${agentId}:${refreshKey}`)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)

  const e = policy?.email
  const hasMessages = (data?.messages.length ?? 0) > 0
  if (!e && !hasMessages) return null

  async function act(key: string, title: string, run: () => Promise<Notice>) {
    setBusy(key); setNotice(null)
    try { setNotice(await run()) } catch (err) {
      const x = asApiError(err)
      setNotice({ ok: false, title, e: x.status === 409 && CONFLICT[x.code] ? new StoreApiError(x.status, x.code, `${CONFLICT[x.code]} (${x.message})`) : x })
    } finally { setBusy(null); await reload(); await onChanged() }
  }
  const post = <T,>(id: string, action: string, body: unknown = {}) => storeFetch<T>(`/api/store/email/messages/${id}/${action}`, { method: 'POST', body })
  const outcome = (r: EmailSendOutcome): Notice => {
    const w = emailWords(r.status)
    if (r.status === 'accepted') return { ok: true, title: 'Accepted by provider.', text: `${EMAIL_ACCEPTED_EXPLAINER}${r.duplicate ? ' This message had already been handed over; it was not sent twice.' : ''}` }
    return { ok: false, title: `${w.label}.`, e: new StoreApiError(0, r.status, `${r.reason ?? w.hint}`) }
  }
  const handlers: Handlers = {
    approve: m => act(`approve:${m.id}`, 'Not sent', async () => outcome(await post<EmailSendOutcome>(m.id, 'approve', { contentHash: m.content_hash }))),
    decline: m => act(`decline:${m.id}`, 'Not declined', async () => { await post(m.id, 'decline'); return { ok: true, title: m.status === 'draft' ? 'Draft discarded.' : 'Declined.', text: 'Nothing was sent.' } }),
    edit: (m, subject, bodyText) => act(`edit:${m.id}`, 'Not saved', async () => {
      const r = await post<EmailEditResponse>(m.id, 'edit', { contentHash: m.content_hash, subject, bodyText })
      return { ok: true, title: 'Edit saved.', text: r.contentHash === m.content_hash ? 'Nothing changed.' : r.status === 'draft' ? 'The draft was updated.' : 'This edited version now needs your approval. Any earlier approval no longer applies.' }
    }),
    retry: m => act(`retry:${m.id}`, 'Not sent', async () => outcome(await post<EmailSendOutcome>(m.id, 'retry'))),
    resolve: (m, decision) => act(`resolve:${m.id}`, 'Not recorded', async () => {
      const r = await post<EmailSendOutcome>(m.id, 'resolve', { decision })
      if (decision === 'was_sent') return { ok: true, title: 'Recorded as sent.', text: 'You confirmed it is in the account\'s Sent folder. It is not sent again.' }
      return outcome(r)
    }),
  }

  const accountOf = (id: string | undefined) => data?.accounts.find(a => a.id === id) ?? null
  const waiting = data?.details ?? []
  const sent = (data?.messages ?? []).filter(m => m.status !== 'awaiting_approval' && m.status !== 'draft')

  return (
    <>
      {e && <EmailAuthorization e={e} account={accountOf(e.accountId)} accountsLoaded={Boolean(data)} />}

      <Section id="email-waiting" title="Messages awaiting your approval" sub="The exact message that would be sent. Approving sends this version only; any change to it needs a new approval.">
        <div aria-live="polite" className="mb-3 flex flex-col gap-3">
          {notice?.ok && <Banner icon="check"><strong>{notice.title}</strong> {notice.text}</Banner>}
          {notice && !notice.ok && <Banner tone="warn"><strong>{notice.title}</strong> {notice.e.message}</Banner>}
          {error && <ErrorState error={error} onRetry={reload} />}
        </div>
        {loading && !data ? <Loading label="Loading messages" rows={1} /> : waiting.length === 0 ? (
          <Empty title="Nothing waiting">No messages from this agent are waiting for you.</Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {waiting.map(m => <WaitingMessage key={m.id} m={m} busy={busy} agentActive={agentActive} h={handlers} />)}
          </ul>
        )}
      </Section>

      <Section id="email-sent" title="Sent email" sub={<>Every message this agent handed to the provider, tried to, or that was cancelled. &ldquo;Accepted by provider&rdquo; is the strongest status: the provider accepted it for delivery, and Deploi cannot confirm it reached the inbox.</>}>
        {loading && !data ? <Loading label="Loading sent email" rows={1} /> : sent.length === 0 ? (
          <Empty title="No sent email yet">Messages appear here once they are approved, sent, declined or cancelled.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">{sent.map(m => <SentMessage key={m.id} m={m} busy={busy} h={handlers} />)}</ul>
        )}
      </Section>
    </>
  )
}

type Handlers = {
  approve: (m: EmailMessageDetail) => void
  decline: (m: EmailMessageDetail) => void
  edit: (m: EmailMessageDetail, subject: string, bodyText: string) => void
  retry: (m: EmailMessageItem) => void
  resolve: (m: EmailMessageItem, decision: 'was_sent' | 'not_sent') => void
}

function EmailAuthorization({ e, account, accountsLoaded }: { e: NonNullable<AgentPolicy['email']>; account: EmailAccountView | null; accountsLoaded: boolean }) {
  const { base } = useStore()
  const expired = e.validUntil ? new Date(e.validUntil).getTime() <= Date.now() : false
  const who = [...(e.recipients?.addresses ?? []), ...(e.recipients?.domains ?? []).map(d => `anyone @${d}`)]
  const items: [ReactNode, ReactNode][] = [
    ['Sender', account
      ? <span key="s" className="inline-flex flex-wrap items-center gap-2"><span className="break-all">{account.address}</span><Badge tone={emailAccountWords(account.status).tone}>{emailAccountWords(account.status).label}</Badge></span>
      : accountsLoaded ? <span key="s" className="text-warn">An account that is no longer connected. <Link href={`${base}/connections`} className="text-ink underline">Connections</Link></span> : '…'],
    ['Permission', AGENT_EMAIL_PERMISSION_LABEL[e.permission] ?? e.permission],
    ['Purpose', <>&ldquo;{e.purpose}&rdquo;</>],
    ['Tasks', e.tasks.map(t => AGENT_EMAIL_TASK_LABEL[t] ?? t).join('; ')],
    ['May write to', who.length ? who.join(', ') : 'nobody'],
  ]
  if (e.notify?.length) items.push(['Summaries and alerts to', e.notify.join(', ')])
  if (e.supplierReorder) items.push(['Supplier', `${e.supplierReorder.supplierAddress} · asks when ${e.supplierReorder.thresholdAvailable} or fewer are available · at most once every ${plural(e.supplierReorder.cooldownDays, 'day')} per product`])
  items.push(['Limits', `${plural(e.limits?.perRun ?? 10, 'message')} per run · ${e.limits?.perDay ?? 25} per day · ${plural(e.maxRecipientsPerMessage ?? 5, 'recipient')} per message · ${e.allowAttachments ? 'attachments allowed' : 'no attachments'}`])
  items.push(['Ends', e.validUntil ? <span key="u" className="inline-flex flex-wrap items-center gap-2">{fmtTime(e.validUntil)}{expired && <Badge tone="danger">Expired</Badge>}</span> : 'No end date'])
  items.push(['Read replies', e.read?.enabled ? 'Yes: only replies to messages this agent sent (who and when, never acted on)' : 'No: it never reads the mailbox'])
  return (
    <Section id="email" title="Email authorization" sub="What this agent may do with email, as granted. Messages outside these boundaries wait for your approval.">
      <Panel tone={expired ? 'warn' : undefined}>
        <Facts items={items} />
        {expired && <p className="pt-3 text-[14px] text-warn">The end date has passed: nothing is sent without asking. Edit the agent to set a new end date and grant it again.</p>}
      </Panel>
    </Section>
  )
}

function Recipients({ m }: { m: Pick<EmailMessageItem, 'to_addresses' | 'cc_addresses'> }) {
  return <>{m.to_addresses.join(', ')}{m.cc_addresses.length ? <span className="block text-grey"><span className="text-grey-h">Cc: </span>{m.cc_addresses.join(', ')}</span> : null}</>
}

function WaitingMessage({ m, busy, agentActive, h }: { m: EmailMessageDetail; busy: string | null; agentActive: boolean; h: Handlers }) {
  const [edit, setEdit] = useState<{ subject: string; body: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const w = emailWords(m.status)
  const c = m.content
  const draft = m.status === 'draft'
  const to = m.to_addresses.join(', ')
  async function copy() {
    if (!c) return
    try { await navigator.clipboard.writeText(`Subject: ${c.subject}\n\n${c.bodyText}`); setCopied(true) } catch { setCopied(false) }
  }
  return (
    <li>
      <Panel>
        <div className="flex flex-wrap items-center gap-2"><StatusBadge w={w} /><Badge tone="muted">{EMAIL_TASK_SHORT[m.task_key] ?? m.task_key}</Badge><span className="text-[13px] text-grey-h">Created {fmtTime(m.created_at)}</span></div>
        <div className="mt-3 text-[14px]">
          <Facts items={[
            ['From', <span key="f" className="break-all">{m.from_address}</span>],
            ['To', <span key="t" className="break-all"><Recipients m={m} /></span>],
            ['Subject', c ? <span key="s" className="text-ink">{c.subject}</span> : <span key="s" className="text-grey-h">Hidden from Deploi staff</span>],
          ]} />
        </div>
        {c && !edit && (
          <pre className="mt-3 max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-[14px] border border-line bg-[#0A0A0A] p-3 text-[14px] text-ink" style={{ fontFamily: 'inherit' }} aria-label="Message body">{c.bodyText}</pre>
        )}
        {c && edit && (
          <div className="mt-3 flex flex-col gap-3 rounded-[14px] border border-line p-3">
            <div className="flex flex-col gap-1">
              <label htmlFor={`subj-${m.id}`} className="text-[14px] text-grey">Subject</label>
              <Input id={`subj-${m.id}`} value={edit.subject} maxLength={250} onChange={e => setEdit({ ...edit, subject: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={`body-${m.id}`} className="text-[14px] text-grey">Body</label>
              <Textarea id={`body-${m.id}`} rows={12} value={edit.body} maxLength={50000} onChange={e => setEdit({ ...edit, body: e.target.value })} />
            </div>
            <p className="text-[13px] text-grey-h">Saving makes this the version that would be sent. {draft ? 'It stays a draft.' : 'It then needs your approval again; any earlier approval no longer applies.'} The sender and recipients cannot be changed here.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => { h.edit(m, edit.subject, edit.body); setEdit(null) }} disabled={busy !== null || !edit.subject.trim()}><Icon name="check" size={15} />{busy === `edit:${m.id}` ? 'Saving…' : 'Save edit'}</Button>
              <Button size="sm" variant="ghost" onClick={() => setEdit(null)} disabled={busy !== null}>Cancel</Button>
            </div>
          </div>
        )}
        {c && c.attachments.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            <div className="text-[14px] text-grey">Attachments</div>
            {c.attachments.map(a => (
              <div key={a.filename} className="rounded-[14px] border border-line p-3">
                <div className="flex flex-wrap items-center gap-2 text-[14px] text-ink"><Icon name="file" size={15} /><span className="break-all">{a.filename}</span><span className="text-grey-h">{a.contentType} · {fmtBytes(a.bytes)}</span></div>
                {a.preview !== null && <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre rounded-[10px] bg-[#0A0A0A] p-2 text-[13px] text-grey" aria-label={`Preview of ${a.filename}`}>{a.preview}</pre>}
              </div>
            ))}
          </div>
        )}
        {m.status_reason && <p className="pt-3 text-[14px] text-grey"><span className="text-grey-h">Why it waits: </span>{m.status_reason}</p>}
        {draft ? (
          <div className="mt-3 flex flex-col gap-2">
            <p className="text-[14px] text-grey">This agent may only draft. Deploi will not send it; copy the text if you want to send it yourself.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onClick={copy} disabled={!c}><Icon name="clipboard" size={15} />{copied ? 'Copied' : 'Copy text'}</Button>
              {c && !edit && <Button size="sm" variant="ghost" onClick={() => setEdit({ subject: c.subject, body: c.bodyText })} disabled={busy !== null}><Icon name="edit" size={15} />Edit</Button>}
              <Button size="sm" variant="ghost" onClick={() => h.decline(m)} disabled={busy !== null}>{busy === `decline:${m.id}` ? 'Discarding…' : 'Discard draft'}</Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => h.approve(m)} disabled={busy !== null || !agentActive || !c || edit !== null} aria-label={`Approve and send to ${to}`}>
              <Icon name="check" size={15} />{busy === `approve:${m.id}` ? 'Sending…' : 'Approve and send'}
            </Button>
            {c && !edit && <Button size="sm" variant="ghost" onClick={() => setEdit({ subject: c.subject, body: c.bodyText })} disabled={busy !== null} aria-label={`Edit message to ${to}`}><Icon name="edit" size={15} />Edit</Button>}
            <Button size="sm" variant="ghost" onClick={() => h.decline(m)} disabled={busy !== null} aria-label={`Decline message to ${to}`}>{busy === `decline:${m.id}` ? 'Declining…' : 'Decline'}</Button>
          </div>
        )}
        {!draft && !agentActive && <p className="pt-2 text-[13px] text-grey-h">The agent is not active, so this message cannot be sent. You can still decline it.</p>}
      </Panel>
    </li>
  )
}

function SentMessage({ m, busy, h }: { m: EmailMessageItem; busy: string | null; h: Handlers }) {
  const { base } = useStore()
  const w = emailWords(m.status)
  const facts: [ReactNode, ReactNode][] = [
    ['From', <span key="f" className="break-all">{m.from_address}</span>],
    ['To', <span key="t" className="break-all"><Recipients m={m} /></span>],
  ]
  if (m.subject !== null) facts.push(['Subject', m.subject])
  facts.push(['Approval', m.approval_kind === 'individual' ? `Approved by you (${actorLabel(m.approved_by)})${m.approved_at ? `, ${fmtTime(m.approved_at)}` : ''}`
    : m.approval_kind === 'standing' ? `Sent under the agent's authorization v${m.policy_version ?? '—'}`
    : 'Not approved'])
  facts.push(['When', `Created ${fmtTime(m.created_at)}${m.accepted_at ? ` · accepted by provider ${fmtTime(m.accepted_at)}` : ` · updated ${fmtTime(m.updated_at)}`}${m.attempts > 1 ? ` · ${m.attempts} attempts` : ''}`])
  if (m.status === 'accepted' && m.accepted_evidence) facts.push(['Evidence', m.accepted_evidence])
  if (m.attachment_count > 0) facts.push(['Attachments', `${m.attachment_count} (${fmtBytes(m.attachment_bytes)})`])
  if (m.reply_count > 0) facts.push(['Replies', `${plural(m.reply_count, 'reply', 'replies')} seen${m.reply_seen_at ? `, latest ${fmtTime(m.reply_seen_at)}` : ''}`])
  const authFailure = m.status === 'failed' && AUTH_FAILURES.has(m.failure_code ?? '')
  return (
    <li className="rounded-[16px] border border-line p-3 md:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span title={w.hint}><StatusBadge w={w} /></span>
        <Badge tone="muted">{EMAIL_TASK_SHORT[m.task_key] ?? m.task_key}</Badge>
      </div>
      <div className="mt-2 text-[14px]"><Facts items={facts} /></div>
      {m.status === 'accepted' && <p className="pt-2 text-[13px] text-grey-h">{EMAIL_ACCEPTED_EXPLAINER}</p>}
      {m.status === 'failed' && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-[14px] text-danger break-words">{m.status_reason ?? 'The provider refused it.'} Nothing was sent.</p>
          <div className="flex flex-wrap items-center gap-2">
            {authFailure && <Link href={`${base}/connections`} className="btn ghost sm"><Icon name="bolt" size={15} />Reconnect the account</Link>}
            <Button size="sm" variant="ghost" onClick={() => h.retry(m)} disabled={busy !== null} aria-label={`Retry message to ${m.to_addresses.join(', ')}`}>{busy === `retry:${m.id}` ? 'Sending…' : 'Retry'}</Button>
          </div>
          {authFailure && <p className="text-[13px] text-grey-h">The account needs to be reconnected before a retry can succeed.</p>}
        </div>
      )}
      {m.status === 'delivery_unknown' && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-[14px] text-warn break-words">{w.hint}{m.status_reason ? ` ${m.status_reason.replace(/^./, x => x.toUpperCase())}.` : ''}</p>
          <p className="text-[13px] text-grey-h">Look for it in the Sent folder of {m.from_address}, then tell Deploi what you found.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => h.resolve(m, 'was_sent')} disabled={busy !== null}>It was sent</Button>
            <Button size="sm" variant="ghost" onClick={() => h.resolve(m, 'not_sent')} disabled={busy !== null}>{busy === `resolve:${m.id}` ? 'Sending…' : 'It was not sent: send it'}</Button>
          </div>
        </div>
      )}
      {(m.status === 'cancelled' || m.status === 'queued' || m.status === 'sending') && m.status_reason && <p className="pt-2 text-[14px] text-grey-h break-words">{m.status_reason}</p>}
    </li>
  )
}
