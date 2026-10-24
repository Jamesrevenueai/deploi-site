'use client'
import { useState } from 'react'
import { Sheet } from '@/components/ui/Sheet'
import { Badge } from '@/components/ui/Badge'
import { Icon } from '@/components/ui/Icon'
import { Field, Input, Textarea } from '@/components/ui/Field'
import { WORKER_LABELS, type WorkerName } from '@/lib/workers/types'

export type ActionView = {
  id: string; agency_name: string | null; worker: string; kind: 'email' | 'sms' | 'task'; to_label: string; about: string | null
  subject: string | null; body: string; status: string; created_at: string; sent_at: string | null; hold_reason?: string | null
  delivery_status?: string | null; simulated?: boolean; expires_at?: string | null; suppressed_reason?: string | null
  failure_reason?: string | null; send_after?: string | null; attempt_count?: number
}

type Actions = { approve: (fd: FormData) => void; editApprove: (fd: FormData) => void; skip: (fd: FormData) => void; retry: (fd: FormData) => void }

const KIND_ICON: Record<ActionView['kind'], string> = { email: 'mail', sms: 'phone', task: 'clipboard' }
const EXTRA_LABELS: Record<string, string> = { inbound_triage: 'Inbound triage' }

export const STATUS_LABEL: Record<string, string> = {
  proposed: 'waiting', approved: 'approved', queued: 'queued', attempted: 'attempted', delivered: 'delivered', failed: 'failed',
  unknown: 'delivery unknown', skipped: 'skipped', expired: 'expired', suppressed: 'suppressed',
}
const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted' | 'none'> = {
  delivered: 'ok', attempted: 'warn', unknown: 'warn', failed: 'danger', expired: 'muted', suppressed: 'muted', skipped: 'muted', queued: 'none', approved: 'none',
}

const fmt = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function workerLabel(w: string) { return WORKER_LABELS[w as WorkerName] ?? EXTRA_LABELS[w] ?? w }

export function ActionCard({ a, actions }: { a: ActionView; actions: Actions }) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const open = a.status === 'proposed'
  const retryable = a.status === 'failed' || a.status === 'unknown'
  const pendingNotOpen = a.status === 'approved' || a.status === 'queued'
  return (
    <li className="rounded-[20px] border border-line p-4 md:p-5 fade-up">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-grey-h">
        <span className="glass" style={{ padding: '5px 10px', fontSize: 13 }}><Icon name={KIND_ICON[a.kind]} size={13} />{a.kind}</span>
        <span className="text-ink font-medium">{workerLabel(a.worker)}</span>
        <span>·</span><span>{a.agency_name ?? 'agency'}</span>
        <span>·</span><span>{fmt(a.created_at)}</span>
        {a.status !== 'proposed' && <Badge tone={STATUS_TONE[a.status] ?? 'muted'}>{STATUS_LABEL[a.status] ?? a.status}</Badge>}
        {a.simulated && <Badge tone="warn">simulated</Badge>}
        {a.status === 'attempted' && a.delivery_status === 'provider_accepted' && <Badge tone="warn">provider accepted, not confirmed</Badge>}
        {a.hold_reason && (open || pendingNotOpen) && <Badge tone="warn">held: {a.hold_reason}</Badge>}
        {a.status === 'queued' && a.send_after && <Badge tone="none"><Icon name="clock" size={12} />sends {fmt(a.send_after)}</Badge>}
        {a.status === 'suppressed' && a.suppressed_reason && <Badge tone="muted">{a.suppressed_reason.replace(/_/g, ' ')}</Badge>}
        {a.status === 'failed' && a.failure_reason && <Badge tone="danger">{a.failure_reason.slice(0, 60)}</Badge>}
        {(open || pendingNotOpen) && a.expires_at && <Badge tone={new Date(a.expires_at) < new Date() ? 'danger' : 'none'}>expires {fmt(a.expires_at)}</Badge>}
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
      {pendingNotOpen && (
        <div className="mt-4 flex flex-wrap gap-2">
          <form action={actions.retry}><input type="hidden" name="id" value={a.id} /><button className="btn ghost sm" type="submit"><Icon name="bolt" size={15} />{a.status === 'queued' ? 'Send now if in window' : 'Execute'}</button></form>
          <form action={actions.skip}><input type="hidden" name="id" value={a.id} /><button className="btn ghost sm" type="submit"><Icon name="skip" size={15} />Skip</button></form>
        </div>
      )}
      {retryable && (
        <div className="mt-4 flex flex-wrap gap-2">
          <form action={actions.retry}><input type="hidden" name="id" value={a.id} /><button className="btn ghost sm" type="submit"><Icon name="bolt" size={15} />Retry{a.attempt_count ? ` (attempt ${a.attempt_count + 1})` : ''}</button></form>
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
