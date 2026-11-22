'use client'
/** A support conversation (customer view and staff view share it). */
import { Badge } from '@/components/ui/Badge'

export type TicketView = { id: string; ref: string; category: string; subject: string; caseRef: string | null; page: string | null; status: string; createdByEmail: string; createdAt: string; updatedAt: string; orgName?: string }
export type MessageView = { id: string; authorKind: 'customer' | 'staff'; authorEmail: string; body: string; createdAt: string; emailStatus?: string | null }

export const STATUS_LABEL: Record<string, string> = { open: 'Open', in_progress: 'In progress', waiting_on_customer: 'Answered', resolved: 'Resolved', closed: 'Closed' }
export const statusTone = (s: string) => (s === 'resolved' || s === 'closed' ? 'ok' : s === 'waiting_on_customer' ? 'info' : 'warn') as 'ok' | 'info' | 'warn'

export function SupportThread({ messages, staffView = false }: { messages: MessageView[]; staffView?: boolean }) {
  return (
    <ol className="flex flex-col gap-3" aria-label="Conversation" data-testid="support-thread">
      {messages.map(m => (
        <li key={m.id} className={`rounded-[12px] border border-line p-3 ${m.authorKind === 'staff' ? 'bg-accent-soft' : ''}`} data-author={m.authorKind}>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-grey-h">
            <span className="font-medium text-ink">{m.authorKind === 'staff' ? 'Deploi support' : m.authorEmail}</span>
            <span>{new Date(m.createdAt).toLocaleString()}</span>
            {staffView && m.authorKind === 'staff' && m.emailStatus && <Badge tone={m.emailStatus === 'sent' ? 'ok' : 'muted'}>email {m.emailStatus}</Badge>}
          </div>
          <p className="whitespace-pre-wrap pt-1 text-[14.5px] text-ink">{m.body}</p>
        </li>
      ))}
    </ol>
  )
}
