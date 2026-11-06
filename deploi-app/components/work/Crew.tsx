'use client'
/**
 * Crew: the people who do the physical work (packers, warehouse, field crew).
 *   CrewSettings   Settings → Crew: add, edit, deactivate and reactivate (owners and admins; others see the list)
 *   CrewToday      Today's crew jobs: who has what, where, and whether it is done; owners and admins can add a
 *                  job, send someone their jobs now, mark a job done or cancel it.
 * The server enforces every rule; these screens only ask.
 */
import { useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Empty } from '@/components/ui/Empty'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { storeFetch, asApiError } from '@/components/store/api'
import { useLoad } from '@/components/store/useLoad'
import { ErrorState, Loading } from '@/components/store/bits'

type Role = 'packer' | 'warehouse' | 'field' | 'other'
type Member = { id: string; name: string; role: Role; email: string | null; phone: string | null; channels: ('email' | 'text')[]; active: boolean }
type Job = { id: string; jobRef: string; crewMemberId: string | null; crewName: string | null; date: string; address: string | null; details: string | null; photos: string[]; status: string; sourceAgent: string | null; doneVia: string | null; doneAt: string | null; lastSentAt: string | null }
type Note = { tone: 'info' | 'warn'; text: string } | null

const ROLE_LABEL: Record<Role, string> = { packer: 'Packer', warehouse: 'Warehouse', field: 'Field crew', other: 'Other' }
const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'muted' | 'info' | 'danger' }> = {
  scheduled: { label: 'Not sent yet', tone: 'muted' }, sent: { label: 'Sent', tone: 'info' }, in_progress: { label: 'In progress', tone: 'info' },
  done: { label: 'Done', tone: 'ok' }, cancelled: { label: 'Cancelled', tone: 'danger' },
}
const CREW_API = '/api/store/crew'
const JOBS_API = '/api/store/crew/jobs'

type Form = { name: string; role: Role; email: string; phone: string; email_on: boolean; text_on: boolean }
const EMPTY: Form = { name: '', role: 'packer', email: '', phone: '', email_on: true, text_on: false }
const toForm = (m: Member): Form => ({ name: m.name, role: m.role, email: m.email ?? '', phone: m.phone ?? '', email_on: m.channels.includes('email'), text_on: m.channels.includes('text') })

function MemberForm({ initial, busy, onSubmit, onCancel, submitLabel }: { initial: Form; busy: boolean; onSubmit: (f: Form) => void; onCancel?: () => void; submitLabel: string }) {
  const [f, setF] = useState<Form>(initial)
  const id = (k: string) => `crew-${k}-${initial.name || 'new'}`.replace(/\s+/g, '-')
  return (
    <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); onSubmit(f) }} aria-label={submitLabel}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Name" htmlFor={id('name')}><Input id={id('name')} required value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Sam Rivera" /></Field>
        <Field label="Role" htmlFor={id('role')}><Select id={id('role')} value={f.role} onChange={e => setF({ ...f, role: e.target.value as Role })}>{(Object.keys(ROLE_LABEL) as Role[]).map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select></Field>
        <Field label="Email" htmlFor={id('email')}><Input id={id('email')} type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} placeholder="sam@your-business.com" /></Field>
        <Field label="Phone" htmlFor={id('phone')} hint="International form, e.g. +15551234567"><Input id={id('phone')} type="tel" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} placeholder="+15551234567" /></Field>
      </div>
      <div className="flex flex-wrap gap-4 text-[14px]">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.email_on} onChange={e => setF({ ...f, email_on: e.target.checked })} /> Send jobs by email</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.text_on} onChange={e => setF({ ...f, text_on: e.target.checked })} /> Send jobs by text</label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !f.name.trim()}>{busy ? 'Saving…' : submitLabel}</Button>
        {onCancel && <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  )
}
const payload = (f: Form) => ({ name: f.name, role: f.role, email: f.email, phone: f.phone, channels: [...(f.email_on ? ['email'] : []), ...(f.text_on ? ['text'] : [])] })

export function CrewSettings() {
  const { data, error, loading, reload } = useLoad(() => storeFetch<{ ok: true; members: Member[]; canManage: boolean }>(CREW_API), 'crew')
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [note, setNote] = useState<Note>(null)
  if (loading && !data) return <Loading label="Loading your crew" rows={2} />
  if (error && !data) return <ErrorState error={error} onRetry={reload} />
  if (!data) return null
  async function post(key: string, body: Record<string, unknown>, ok: string) {
    setBusy(key); setNote(null)
    try { await storeFetch(CREW_API, { method: 'POST', body }); setNote({ tone: 'info', text: ok }); setEditing(null); await reload() } catch (e) { setNote({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(null) }
  }
  return (
    <div className="flex flex-col gap-4" data-testid="crew-settings">
      <div aria-live="polite">{note && <Banner tone={note.tone} icon={note.tone === 'info' ? 'check' : 'alert'}>{note.text}</Banner>}</div>
      {data.members.length === 0 ? <Empty title="No crew yet">Add the people who pack, pick or go out on jobs. Agents send them their jobs and they tap Mark done when finished.</Empty> : (
        <ul className="flex flex-col gap-2" aria-label="Crew members">
          {data.members.map(m => (
            <li key={m.id} className="panel flex flex-col gap-3 p-4" data-crew={m.name}>
              {editing === m.id ? <MemberForm initial={toForm(m)} busy={busy !== null} submitLabel="Save changes" onCancel={() => setEditing(null)} onSubmit={f => void post(`edit:${m.id}`, { action: 'update', id: m.id, ...payload(f) }, `${f.name} was updated.`)} /> : (
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <div className="font-semibold text-ink">{m.name} <span className="font-normal text-grey-h">· {ROLE_LABEL[m.role]}</span></div>
                    <div className="text-[13px] text-grey break-all">{[m.email, m.phone].filter(Boolean).join(' · ') || 'No contact details'}</div>
                    <div className="text-[13px] text-grey-h">Gets jobs by {m.channels.length ? m.channels.join(' and ') : 'nothing yet'}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={m.active ? 'ok' : 'muted'}>{m.active ? 'Active' : 'Deactivated'}</Badge>
                    {data.canManage && <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => setEditing(m.id)}>Edit</Button>}
                    {data.canManage && (m.active
                      ? <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void post(`off:${m.id}`, { action: 'deactivate', id: m.id }, `${m.name} is deactivated: no more messages, and their links stop working.`)}>Deactivate</Button>
                      : <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void post(`on:${m.id}`, { action: 'reactivate', id: m.id }, `${m.name} is active again.`)}>Reactivate</Button>)}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {data.canManage ? (
        <div className="panel flex flex-col gap-3 p-4">
          <h3 className="text-[15px]">Add a crew member</h3>
          <MemberForm key={data.members.length} initial={EMPTY} busy={busy !== null} submitLabel="Add to crew" onSubmit={f => void post('add', { action: 'add', ...payload(f) }, `${f.name} was added to your crew.`)} />
        </div>
      ) : <p className="text-[13px] text-grey-h">Owners and admins add and change crew members.</p>}
    </div>
  )
}

export function CrewToday() {
  const [date, setDate] = useState('')
  const { data, error, loading, reload } = useLoad(() => storeFetch<{ ok: true; date: string; jobs: Job[]; canManage: boolean }>(`${JOBS_API}${date ? `?date=${encodeURIComponent(date)}` : ''}`), `crew-jobs:${date}`)
  const crew = useLoad(() => storeFetch<{ ok: true; members: Member[]; canManage: boolean }>(CREW_API), 'crew-for-jobs')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<Note>(null)
  const [add, setAdd] = useState({ jobRef: '', crewMemberId: '', address: '', details: '' })
  if (loading && !data) return <Loading label="Loading today's crew jobs" rows={3} />
  if (error && !data) return <ErrorState error={error} onRetry={reload} />
  if (!data) return null
  const members = (crew.data?.members ?? []).filter(m => m.active)
  async function post(key: string, body: Record<string, unknown>, ok: string) {
    setBusy(key); setNote(null)
    try { await storeFetch(JOBS_API, { method: 'POST', body }); setNote({ tone: 'info', text: ok }); await reload() } catch (e) { setNote({ tone: 'warn', text: asApiError(e).message }) } finally { setBusy(null) }
  }
  const byPerson = new Map<string, Job[]>()
  for (const j of data.jobs) { const k = j.crewName ?? 'Not assigned'; byPerson.set(k, [...(byPerson.get(k) ?? []), j]) }
  const done = data.jobs.filter(j => j.status === 'done').length
  return (
    <div className="flex flex-col gap-4" data-testid="crew-today">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-[14px] text-grey">{data.jobs.length ? `${done} of ${data.jobs.filter(j => j.status !== 'cancelled').length} done` : 'No jobs for this day.'}</p>
        <Field label="Day" htmlFor="crew-day"><Input id="crew-day" type="date" value={date || data.date} onChange={e => setDate(e.target.value)} /></Field>
      </div>
      <div aria-live="polite">{note && <Banner tone={note.tone} icon={note.tone === 'info' ? 'check' : 'alert'}>{note.text}</Banner>}</div>
      {[...byPerson.entries()].map(([person, jobs]) => {
        const memberId = jobs[0]?.crewMemberId
        return (
          <section key={person} className="flex flex-col gap-2" aria-label={`Jobs for ${person}`}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[15px]">{person}</h3>
              {data.canManage && memberId && <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void post(`send:${memberId}`, { action: 'send', crewMemberId: memberId }, `${person} was sent today's jobs.`)}>Send jobs now</Button>}
            </div>
            <ul className="flex flex-col gap-2">
              {jobs.map(j => (
                <li key={j.id} className="panel flex flex-col gap-2 p-4 md:flex-row md:items-start md:justify-between" data-job={j.jobRef}>
                  <div className="min-w-0">
                    <div className="font-semibold text-ink">{j.jobRef}{j.address && <span className="font-normal text-grey"> · {j.address}</span>}</div>
                    {j.details && <p className="pt-1 text-[14px] text-grey whitespace-pre-wrap">{j.details}</p>}
                    <p className="pt-1 text-[13px] text-grey-h">
                      {j.sourceAgent ? `From ${j.sourceAgent === 'owner' ? 'you' : j.sourceAgent}` : ''}
                      {j.photos.length ? ` · ${j.photos.length} photo${j.photos.length === 1 ? '' : 's'}` : ''}
                      {j.lastSentAt ? ` · last sent ${new Date(j.lastSentAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
                      {j.status === 'done' && j.doneVia ? ` · marked done ${j.doneVia === 'link' ? 'from the link' : j.doneVia === 'reply' ? 'by reply' : 'by you'}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Badge tone={(STATUS[j.status] ?? STATUS.scheduled).tone}>{(STATUS[j.status] ?? STATUS.scheduled).label}</Badge>
                    {data.canManage && j.status !== 'done' && j.status !== 'cancelled' && <>
                      <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void post(`done:${j.id}`, { action: 'mark_done', jobId: j.id }, `${j.jobRef} is marked done.`)}>Mark done</Button>
                      <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => { if (window.confirm(`Cancel ${j.jobRef}?`)) void post(`cancel:${j.id}`, { action: 'cancel', jobId: j.id }, `${j.jobRef} was cancelled.`) }}>Cancel</Button>
                    </>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      {data.canManage && (
        <form className="panel flex flex-col gap-3 p-4" aria-label="Add a job" onSubmit={e => { e.preventDefault(); void post('add', { action: 'add_job', ...add, date: date || data.date }, `${add.jobRef} was added.`).then(() => setAdd({ jobRef: '', crewMemberId: add.crewMemberId, address: '', details: '' })) }}>
          <h3 className="text-[15px]">Add a job</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Job number" htmlFor="job-ref"><Input id="job-ref" required value={add.jobRef} onChange={e => setAdd({ ...add, jobRef: e.target.value })} placeholder="J-1042" /></Field>
            <Field label="Crew member" htmlFor="job-crew"><Select id="job-crew" value={add.crewMemberId} onChange={e => setAdd({ ...add, crewMemberId: e.target.value })}><option value="">Not assigned</option>{members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
            <Field label="Address" htmlFor="job-address"><Input id="job-address" value={add.address} onChange={e => setAdd({ ...add, address: e.target.value })} placeholder="12 Main St, Springfield" /></Field>
          </div>
          <Field label="Details" htmlFor="job-details"><Textarea id="job-details" rows={3} value={add.details} onChange={e => setAdd({ ...add, details: e.target.value })} placeholder="What to do, what to bring, who to ask for." /></Field>
          <div><Button type="submit" size="sm" disabled={busy !== null || !add.jobRef.trim()}>{busy === 'add' ? 'Adding…' : 'Add job'}</Button></div>
        </form>
      )}
    </div>
  )
}
