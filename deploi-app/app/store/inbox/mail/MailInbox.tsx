'use client'
/**
 * Customer inbox (/store/inbox/mail): every agent mailbox's conversations. Replies to agent mail land
 * here in order with what the agent sent. You can mark conversations read or unread, label one with an
 * agent, and reply as yourself: the reply leaves from the agent's mailbox through the same checks as
 * agent mail (allowed recipients, unsubscribes and bounces, daily limit, live-send setting).
 * Incoming mail is shown as text to read; nothing in it is acted on, and attachments are listed only.
 */
import { useMemo, useState } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { storeFetch, asApiError, type StoreApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { Chips, ErrorState, Loading, Panel } from '@/components/store/bits'
import { fmtTime } from '@/components/store/format'

type Thread = { key: string; agentId: string | null; agentName: string | null; mailbox: string | null; subject: string | null; participants: string[]; lastAt: string; unread: boolean; inboundCount: number; outboundCount: number; assignedAgentId: string | null; assignedAgentName: string | null; quarantined: boolean }
type Item = { id: string; direction: 'outbound' | 'inbound'; at: string; from: string; to: string[]; status: string; statusReason: string | null; subject: string | null; body: string | null; byPerson: string | null; attachments: { filename: string; contentType: string; size: number | null }[]; autoReply: string | null }
type Filter = 'all' | 'unread' | 'assigned'

const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')

export function MailInbox() {
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<string | null>(null)
  const list = useLoad(() => storeFetch<{ threads: Thread[] }>(`/api/store/inbox/threads?filter=${filter}`), `threads:${filter}`)
  const header = <PageHeader title="Inbox" sub="Replies to your agents' email, and mail sent to their addresses. Read it, label it, or reply yourself from the agent's address. Nothing here is acted on by an agent." />
  if (list.error) return <>{header}<ErrorState error={list.error} onRetry={list.reload} /></>
  return (
    <>
      {header}
      <div className="mb-4"><Chips label="Show" value={filter} onChange={v => { setFilter(v); setOpen(null) }} options={[['all', 'All'], ['unread', 'Unread'], ['assigned', 'Labelled']]} /></div>
      {list.loading && !list.data ? <Loading label="Loading conversations" /> : !list.data?.threads.length ? <Empty title="No conversations yet">When someone replies to an agent, or writes to an agent&apos;s address, it appears here.</Empty> : (
        <ul className="flex flex-col gap-2">
          {list.data.threads.map(t => (
            <li key={t.key}>
              <Panel tone={t.quarantined ? 'warn' : undefined}>
                <button type="button" className="w-full text-left" onClick={() => setOpen(open === t.key ? null : t.key)} aria-expanded={open === t.key}>
                  <div className="flex flex-wrap items-center gap-2">
                    {t.unread && <Badge tone="warn">Unread</Badge>}
                    {t.quarantined && <Badge tone="danger">Quarantined</Badge>}
                    {t.assignedAgentName && <Badge tone="muted">{t.assignedAgentName}</Badge>}
                    <span className="min-w-0 break-words font-medium text-ink">{t.subject ?? '(subject hidden)'}</span>
                  </div>
                  <p className="pt-1 text-[13px] text-grey-h">{t.mailbox ?? 'agent mailbox'}{t.agentName ? ` (${t.agentName})` : ''} · {t.participants.slice(0, 3).join(', ')} · {t.inboundCount} in, {t.outboundCount} out · {fmtTime(t.lastAt)}</p>
                </button>
                {open === t.key && <ThreadView threadKey={t.key} onChanged={list.reload} />}
              </Panel>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function ThreadView({ threadKey, onChanged }: { threadKey: string; onChanged: () => void }) {
  const t = useLoad(() => storeFetch<{ thread: Thread; items: Item[] }>(`/api/store/inbox/threads/${encodeURIComponent(threadKey)}`), threadKey)
  const [draft, setDraft] = useState('')
  const idem = useMemo(newKey, [threadKey])
  const [key, setKey] = useState(idem)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<StoreApiError | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const path = `/api/store/inbox/threads/${encodeURIComponent(threadKey)}`
  async function act(name: string, fn: () => Promise<string | null>) {
    setBusy(name); setErr(null); setNote(null)
    try { setNote(await fn()) } catch (e) { setErr(asApiError(e)) } finally { setBusy(null); await t.reload(); onChanged() }
  }
  if (t.error) return <ErrorState error={t.error} onRetry={t.reload} />
  if (!t.data) return <Loading label="Loading the conversation" rows={2} />
  const { thread, items } = t.data
  return (
    <div className="mt-3 flex flex-col gap-3">
      <ol className="flex flex-col gap-2">
        {items.map(i => (
          <li key={i.id} className={`rounded-[14px] border border-line p-3 ${i.direction === 'outbound' ? 'bg-sunken' : ''}`}>
            <div className="flex flex-wrap items-center gap-2 text-[13px] text-grey-h">
              <Badge tone={i.direction === 'outbound' ? 'muted' : 'none'}>{i.direction === 'outbound' ? (i.byPerson ? 'You replied' : 'Agent sent') : 'Received'}</Badge>
              {i.direction === 'inbound' && i.status === 'quarantined' && <Badge tone="danger">Quarantined</Badge>}
              {i.autoReply && <Badge tone="muted">Automatic reply: not counted, never answered by an agent</Badge>}
              {i.direction === 'outbound' && <Badge tone={i.status === 'accepted' ? 'ok' : i.status === 'failed' ? 'danger' : 'muted'}>{i.status.replace('_', ' ')}</Badge>}
              <span>{i.from} → {i.to.join(', ')} · {fmtTime(i.at)}</span>
            </div>
            {i.subject && <p className="pt-1 font-medium text-ink break-words">{i.subject}</p>}
            {i.body !== null ? <pre className="whitespace-pre-wrap break-words pt-1 font-sans text-[14px] text-grey">{i.body}</pre> : <p className="pt-1 text-[13px] text-grey-h">(content not shown)</p>}
            {i.attachments.length > 0 && <p className="pt-1 text-[13px] text-grey-h">Attachments (listed only; not opened or stored): {i.attachments.map(a => `${a.filename} (${a.contentType}${a.size ? `, ${a.size} bytes` : ''})`).join('; ')}</p>}
            {i.statusReason && i.direction === 'outbound' && i.status !== 'accepted' && <p className="pt-1 text-[13px] text-grey-h">{i.statusReason}</p>}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act('read', async () => { await storeFetch(`${path}/${thread.unread ? 'read' : 'unread'}`, { method: 'POST', body: {} }); return null })}>{thread.unread ? 'Mark read' : 'Mark unread'}</Button>
        {thread.agentId && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act('assign', async () => { await storeFetch(`${path}/assign`, { method: 'POST', body: { agentId: thread.assignedAgentId ? null : thread.agentId } }); return null })}>{thread.assignedAgentId ? 'Remove label' : `Label with ${thread.agentName ?? 'agent'}`}</Button>}
      </div>
      {!thread.quarantined && (
        <form className="flex flex-col gap-2" onSubmit={e => { e.preventDefault(); void act('reply', async () => { const r = await storeFetch<{ status: string; reason?: string | null }>(`${path}/reply`, { method: 'POST', body: { bodyText: draft, idempotencyKey: key } }); if (r.status === 'accepted') { setDraft(''); setKey(newKey()) } return r.status === 'accepted' ? 'Sent: accepted by the provider (not proof of delivery).' : `Not sent: ${r.reason ?? r.status}` }) }}>
          <label className="text-[13px] text-grey-h" htmlFor={`reply-${threadKey}`}>Reply as yourself from {thread.mailbox ?? 'the agent mailbox'}</label>
          <textarea id={`reply-${threadKey}`} className="min-h-[96px] rounded-[12px] border border-line bg-transparent p-2 text-[14px] text-ink" value={draft} onChange={e => setDraft(e.target.value)} maxLength={20000} />
          <div><Button size="sm" type="submit" disabled={busy !== null || !draft.trim()}>{busy === 'reply' ? 'Sending…' : 'Send reply'}</Button></div>
        </form>
      )}
      {note && <Banner tone="info">{note}</Banner>}
      {err && <Banner tone="warn">{err.message}</Banner>}
    </div>
  )
}
