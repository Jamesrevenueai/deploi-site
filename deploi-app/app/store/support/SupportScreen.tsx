'use client'
/** The customer's own support requests (/store/support): the list, one conversation, and a reply box. */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Field, Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading } from '@/components/store/bits'
import { SupportThread, STATUS_LABEL, statusTone, type MessageView, type TicketView } from '@/components/support/SupportThread'
import { caseHref } from '@/lib/store/nav'

export function SupportScreen() {
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => { try { setSelected(new URLSearchParams(window.location.search).get('ticket')) } catch { /* no window */ } }, [])
  const list = useLoad(() => storeFetch<{ tickets: TicketView[] }>('/api/store/support'), 'support')
  const one = useLoad(() => (selected ? storeFetch<{ ticket: TicketView; messages: MessageView[] }>(`/api/store/support?ticket=${encodeURIComponent(selected)}`) : Promise.resolve(null)), `support:${selected ?? ''}`)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const header = <PageHeader title="Support requests" sub="What you asked Deploi support, and the answers. Use Help → Get help on any page to ask something new." />
  if (list.loading && !list.data) return <>{header}<Loading label="Loading support requests" /></>
  if (list.error && !list.data) return <>{header}<ErrorState error={list.error} onRetry={list.reload} /></>
  const tickets = list.data?.tickets ?? []

  async function send() {
    setBusy(true); setErr(null)
    try { await storeFetch('/api/store/support', { method: 'POST', body: { action: 'reply', ticketId: selected, message: reply } }); setReply(''); await one.reload(); await list.reload() } catch (e) { setErr(asApiError(e).message) } finally { setBusy(false) }
  }
  return (
    <>
      {header}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,340px)_1fr]">
        <ul className="flex flex-col gap-2" aria-label="Your support requests">
          {tickets.length === 0 && <Empty title="No support requests yet">Ask from the Help menu on any page.</Empty>}
          {tickets.map(t => (
            <li key={t.id}>
              <button type="button" onClick={() => setSelected(t.id)} className={`panel block w-full p-3 text-left ${selected === t.id ? 'border-[var(--c-accent-line)]' : ''}`} data-ticket={t.ref} aria-current={selected === t.id ? 'true' : undefined}>
                <div className="flex flex-wrap items-center gap-2"><span className="text-[12.5px] text-grey-h">{t.ref}</span><Badge tone={statusTone(t.status)}>{STATUS_LABEL[t.status] ?? t.status}</Badge></div>
                <div className="pt-1 font-medium text-ink">{t.subject}</div>
              </button>
            </li>
          ))}
        </ul>
        <div>
          {!selected && tickets.length > 0 && <p className="text-[14px] text-grey">Choose a request to see the conversation.</p>}
          {selected && one.error && <ErrorState error={one.error} onRetry={one.reload} />}
          {selected && one.data && (
            <section aria-label={`Support request ${one.data.ticket.ref}`} className="flex flex-col gap-3">
              <div>
                <h2 className="text-[1.2rem]">{one.data.ticket.subject}</h2>
                <p className="text-[13px] text-grey-h">{one.data.ticket.ref} · {STATUS_LABEL[one.data.ticket.status] ?? one.data.ticket.status}{one.data.ticket.caseRef ? <> · about <Link className="link" href={caseHref(one.data.ticket.caseRef)}>{one.data.ticket.caseRef}</Link></> : null}</p>
              </div>
              <SupportThread messages={one.data.messages} />
              <form className="flex flex-col gap-2" onSubmit={e => { e.preventDefault(); void send() }}>
                <Field label="Add a message" htmlFor="support-reply"><Textarea id="support-reply" rows={3} maxLength={8000} value={reply} onChange={e => setReply(e.target.value)} /></Field>
                {err && <p className="text-[13px] text-warn" role="alert">{err}</p>}
                <div><Button type="submit" size="sm" disabled={busy || !reply.trim()}>{busy ? 'Sending…' : 'Send'}</Button></div>
              </form>
            </section>
          )}
        </div>
      </div>
    </>
  )
}
