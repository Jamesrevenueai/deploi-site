'use client'
/** Small pieces shared by the Office screens. */
import { Badge } from '@/components/ui/Badge'

export type Payload =
  | { type: 'email'; to: string; subject: string; body: string; meta?: Record<string, unknown> }
  | { type: 'event'; summary: string; description: string; start: string; end: string; timeZone: string; attendees: string[]; meet: boolean }
  | { type: 'event_patch'; start: string; end: string }
  | { type: 'event_delete'; eventId: string }
  | { type: 'note'; contactId: string; body: string }
  | { type: 'task'; contactId: string; subject: string; body: string }
  | { type: 'contact_update'; contactId: string; properties: Record<string, string> }
  | { type: 'deal_stage'; dealId: string; stage: string }

const TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted'> = {
  succeeded: 'ok', active: 'ok', booked: 'ok', replied: 'ok', completed: 'ok',
  awaiting_approval: 'warn', queued: 'warn', executing: 'warn', unknown: 'warn', paused: 'warn', proposed: 'warn', pending_grant: 'warn', needs_reauth: 'warn', draft: 'muted',
  failed: 'danger', cancelled: 'muted', rejected: 'muted', revoked: 'danger', stopped: 'muted', blocked: 'warn',
}
const LABEL: Record<string, string> = { awaiting_approval: 'Waiting for you', succeeded: 'Done (confirmed)', unknown: 'Checking outcome', queued: 'Queued', executing: 'In progress', draft: 'Draft only', needs_reauth: 'Reconnect needed', pending_grant: 'Waiting for your grant' }
export const StatusBadge = ({ status }: { status: string }) => <Badge tone={TONE[status] ?? 'muted'}>{LABEL[status] ?? status.replace(/_/g, ' ')}</Badge>

export const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—')

export function PayloadView({ p }: { p: Payload }) {
  if (p.type === 'email') return (
    <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-[14px]">
      <dt className="text-grey-h">To</dt><dd className="m-0 break-all">{p.to} <span className="text-grey-h">(only this address)</span></dd>
      <dt className="text-grey-h">Subject</dt><dd className="m-0">{p.subject}</dd>
      <dt className="text-grey-h">Message</dt><dd className="m-0"><pre className="whitespace-pre-wrap font-sans text-[14px] text-ink">{p.body}</pre></dd>
    </dl>
  )
  if (p.type === 'event') return (
    <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-[14px]">
      <dt className="text-grey-h">Event</dt><dd className="m-0">{p.summary}</dd>
      <dt className="text-grey-h">When</dt><dd className="m-0">{fmt(p.start)} – {fmt(p.end)} ({p.timeZone})</dd>
      <dt className="text-grey-h">Guest</dt><dd className="m-0 break-all">{p.attendees.join(', ')}</dd>
      <dt className="text-grey-h">Video</dt><dd className="m-0">{p.meet ? 'Google Meet link added' : 'No video link'}</dd>
    </dl>
  )
  if (p.type === 'note' || p.type === 'task') return <p className="text-[14px]">HubSpot {p.type} on contact {p.contactId}: <span className="text-grey">{p.body}</span></p>
  if (p.type === 'contact_update') return <p className="text-[14px]">HubSpot contact {p.contactId}: {Object.entries(p.properties).map(([k, v]) => `${k} → ${v}`).join(', ')}</p>
  if (p.type === 'deal_stage') return <p className="text-[14px]">HubSpot deal {p.dealId}: stage → {p.stage}</p>
  if (p.type === 'event_patch') return <p className="text-[14px]">Move the event to {fmt(p.start)}</p>
  return <p className="text-[14px]">Cancel the calendar event</p>
}
