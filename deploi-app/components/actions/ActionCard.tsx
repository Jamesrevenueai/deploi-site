'use client'
import { useState } from 'react'
import { Sheet } from '@/components/ui/Sheet'
import { Badge } from '@/components/ui/Badge'
import { Icon } from '@/components/ui/Icon'
import { Field, Input, Textarea } from '@/components/ui/Field'
import { WORKER_LABELS, type WorkerName } from '@/lib/workers/types'

export type ActionView = {
  id: string; agency_name: string | null; worker: WorkerName; kind: 'email' | 'sms' | 'task'; to_label: string; about: string | null
  subject: string | null; body: string; status: string; created_at: string; sent_at: string | null; hold_reason?: string | null
}

type Actions = { approve: (fd: FormData) => void; editApprove: (fd: FormData) => void; skip: (fd: FormData) => void }

const KIND_ICON: Record<ActionView['kind'], string> = { email: 'mail', sms: 'phone', task: 'clipboard' }

export function ActionCard({ a, actions }: { a: ActionView; actions: Actions }) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const open = a.status === 'proposed'
  const when = new Date(a.created_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return (
    <li className="rounded-[20px] border border-line p-4 md:p-5 fade-up">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-grey-h">
        <span className="glass" style={{ padding: '5px 10px', fontSize: 13 }}><Icon name={KIND_ICON[a.kind]} size={13} />{a.kind}</span>
        <span className="text-ink font-medium">{WORKER_LABELS[a.worker] ?? a.worker}</span>
        <span>·</span><span>{a.agency_name ?? 'agency'}</span>
        <span>·</span><span>{when}</span>
        {a.status !== 'proposed' && <Badge tone={a.status === 'sent' ? 'ok' : 'muted'}>{a.status}</Badge>}
        {a.status === 'proposed' && a.hold_reason && <Badge tone="warn">held: {a.hold_reason}</Badge>}
      </div>
      <div className="mt-2 text-[15px]"><span className="text-grey-h">To </span><span className="text-ink">{a.to_label}</span>{a.about && <span className="text-grey-h"> · about {a.about}</span>}</div>
      {a.subject && <div className="mt-1 text-ink font-medium">{a.subject}</div>}
      <p className={`mt-1 text-[15px] text-grey ${expanded ? '' : 'line-clamp-3'}`}>{a.body}</p>
      {a.body.length > 180 && <button type="button" className="mt-1 text-[13px] text-ink underline" onClick={() => setExpanded(v => !v)}>{expanded ? 'Less' : 'More'}</button>}
      {open && (
        <div className="mt-4 flex flex-wrap gap-2">
          <form action={actions.approve}><input type="hidden" name="id" value={a.id} /><button className="btn sm" type="submit"><Icon name="check" size={15} />Approve{a.kind === 'task' ? '' : ' & send'}</button></form>
          <button type="button" className="btn ghost sm" onClick={() => setEditing(true)}><Icon name="edit" size={15} />Edit</button>
          <form action={actions.skip}><input type="hidden" name="id" value={a.id} /><button className="btn ghost sm" type="submit"><Icon name="skip" size={15} />Skip</button></form>
        </div>
      )}
      <Sheet open={editing} onClose={() => setEditing(false)} title="Edit before sending">
        <form action={actions.editApprove} className="flex flex-col gap-4">
          <input type="hidden" name="id" value={a.id} />
          {a.kind === 'email' && <Field label="Subject" htmlFor={`s-${a.id}`}><Input id={`s-${a.id}`} name="subject" defaultValue={a.subject ?? ''} /></Field>}
          <Field label={a.kind === 'sms' ? 'Text message' : 'Body'} htmlFor={`b-${a.id}`} hint={a.kind === 'sms' ? 'Keep it short; this goes out as one text.' : undefined}>
            <Textarea id={`b-${a.id}`} name="body" defaultValue={a.body} rows={6} required />
          </Field>
          <button className="btn" type="submit"><Icon name="check" size={16} />Send edited version</button>
        </form>
      </Sheet>
    </li>
  )
}
