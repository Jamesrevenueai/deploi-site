'use client'
/** Staff support desk (/staff/support): every request, its status, the conversation and a reply (emailed to the customer). */
import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Field, Select, Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading } from '@/components/store/bits'
import { SupportThread, STATUS_LABEL, statusTone, type MessageView, type TicketView } from '@/components/support/SupportThread'

const API = '/api/staff/support'
const STATUSES = ['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed']

export function StaffSupport() {
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => { try { setSelected(new URLSearchParams(window.location.search).get('ticket')) } catch { /* no window */ } }, [])
  const list = useLoad(() => storeFetch<{ tickets: TicketView[] }>(`${API}${filter ? `?status=${filter}` : ''}`), `staff-support:${filter}`)
  const one = useLoad(() => (selected ? storeFetch<{ ticket: TicketView; messages: MessageView[] }>(`${API}?ticket=${encodeURIComponent(selected)}`) : Promise.resolve(null)), `staff-support-one:${selected ?? ''}`)
  const [reply, setReply] = useState('')
  const [after, setAfter] = useState('waiting_on_customer')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const header = <PageHeader title="Support" sub="Customer requests from the in-app Help menu. Replies are emailed to the customer through the system mailer and appear in their support view." />
  if (list.loading && !list.data) return <>{header}<Loading label="Loading support requests" /></>
  if (list.error && !list.data) return <>{header}<ErrorState error={list.error} onRetry={list.reload} /></>

  async function post(body: Record<string, unknown>, done: string) {
    setBusy(true); setNote(null)
    try { await storeFetch(API, { method: 'POST', body: { ticketId: selected, ...body } }); setNote(done); await one.reload(); await list.reload() } catch (e) { setNote(asApiError(e).message) } finally { setBusy(false) }
  }
  return (
    <>
      {header}
      <div className="mb-3 flex items-center gap-2"><label htmlFor="support-filter" className="text-[14px] text-grey">Status</label>
        <Select id="support-filter" value={filter} onChange={e => setFilter(e.target.value)}><option value="">All</option>{STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</Select></div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,380px)_1fr]">
        <ul className="flex flex-col gap-2" aria-label="Support requests">
          {(list.data?.tickets ?? []).length === 0 && <Empty title="No support requests">Nothing matches.</Empty>}
          {(list.data?.tickets ?? []).map(t => (
            <li key={t.id}>
              <button type="button" onClick={() => setSelected(t.id)} className={`panel block w-full p-3 text-left ${selected === t.id ? 'border-[var(--c-accent-line)]' : ''}`} data-ticket={t.ref}>
                <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-grey-h"><span>{t.ref}</span><span>{t.orgName}</span><Badge tone={statusTone(t.status)}>{STATUS_LABEL[t.status] ?? t.status}</Badge><Badge tone="muted">{t.category}</Badge></div>
                <div className="pt-1 font-medium text-ink">{t.subject}</div>
                <div className="text-[12.5px] text-grey-h">{t.createdByEmail} · {new Date(t.updatedAt).toLocaleString()}</div>
              </button>
            </li>
          ))}
        </ul>
        <div>
          {selected && one.error && <ErrorState error={one.error} onRetry={one.reload} />}
          {selected && one.data && (
            <section className="flex flex-col gap-3" aria-label={`Support request ${one.data.ticket.ref}`}>
              <div>
                <h2 className="text-[1.2rem]">{one.data.ticket.subject}</h2>
                <p className="text-[13px] text-grey-h">{one.data.ticket.ref} · {one.data.ticket.orgName} · {one.data.ticket.createdByEmail}{one.data.ticket.caseRef ? ` · case ${one.data.ticket.caseRef}` : ''}{one.data.ticket.page ? ` · from ${one.data.ticket.page}` : ''}</p>
              </div>
              <SupportThread messages={one.data.messages} staffView />
              {note && <p className="text-[13px] text-grey" role="status">{note}</p>}
              <form className="flex flex-col gap-2" onSubmit={e => { e.preventDefault(); void post({ action: 'reply', message: reply, status: after }, 'Reply sent.').then(() => setReply('')) }}>
                <Field label="Reply to the customer" htmlFor="staff-reply"><Textarea id="staff-reply" rows={4} maxLength={8000} value={reply} onChange={e => setReply(e.target.value)} /></Field>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Then mark as" htmlFor="staff-after"><Select id="staff-after" value={after} onChange={e => setAfter(e.target.value)}>{STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</Select></Field>
                  <Button type="submit" size="sm" disabled={busy || !reply.trim()}>{busy ? 'Sending…' : 'Send reply'}</Button>
                </div>
              </form>
              <div className="flex flex-wrap gap-2">{['in_progress', 'resolved', 'closed'].map(s => <Button key={s} size="xs" variant="ghost" disabled={busy || one.data!.ticket.status === s} onClick={() => void post({ action: 'status', status: s }, `Marked ${STATUS_LABEL[s].toLowerCase()}.`)}>Mark {STATUS_LABEL[s].toLowerCase()}</Button>)}</div>
            </section>
          )}
        </div>
      </div>
    </>
  )
}
