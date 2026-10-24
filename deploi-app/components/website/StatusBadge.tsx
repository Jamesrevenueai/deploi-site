import { Badge } from '@/components/ui/Badge'
import { STATUS_LABEL, type PaymentStatus, type Status } from '@/lib/website/states'

const TONE: Record<Status, 'ok' | 'warn' | 'danger' | 'muted' | 'none'> = {
  inquiry: 'muted', scope_confirmed: 'none', accepted: 'none', payment_confirmed: 'ok', access_received: 'ok', improving: 'warn',
  preview_ready: 'warn', customer_approved: 'ok', published: 'ok', completed: 'ok', cancelled: 'danger',
}

export function StatusBadge({ status }: { status: Status }) {
  return <Badge tone={TONE[status] ?? 'none'}>{STATUS_LABEL[status] ?? status}</Badge>
}

/** Payment state. A mock payment is always labelled simulated and never reads as paid. */
export function PaymentBadge({ status, isMock }: { status: PaymentStatus; isMock: boolean }) {
  if (status === 'mock_paid' || (isMock && status !== 'unpaid' && status !== 'refunded')) return <Badge tone="warn">mock_paid (simulated)</Badge>
  if (status === 'paid') return <Badge tone="ok">paid</Badge>
  if (status === 'refunded') return <Badge tone="danger">refunded</Badge>
  return <Badge tone="muted">unpaid</Badge>
}
