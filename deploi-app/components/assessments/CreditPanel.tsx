import { recordPaymentAction } from '@/lib/credit/actions'
import { creditLedgerState, creditDaysLeft, remainingCents, CREDIT_STATE_LABEL, PAYMENT_STATUS_LABEL, type CreditRow, type CreditApplicationRow } from '@/lib/credit/ledger'
import { getService } from '@/lib/catalog/services'
import { getPricing } from '@/lib/catalog/pricing'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'

const money = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US')
const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')

export function stateTone(s: ReturnType<typeof creditLedgerState>) {
  return (s === 'available' || s === 'applied' || s === 'partially_applied' ? 'ok' : s === 'expired' || s === 'refunded' ? 'danger' : 'warn') as 'ok' | 'danger' | 'warn'
}

/** Ledger view of one assessment credit with the two staff payment actions. */
export function CreditPanel({ credit, applications, back, compact }: { credit: CreditRow | null; applications: CreditApplicationRow[]; back: string; compact?: boolean }) {
  const pricing = getPricing()
  if (!credit) {
    return (
      <section id="credit" className="rounded-[20px] border border-line p-4 md:p-5">
        <h3 className="text-base mb-2">Assessment credit</h3>
        <Empty title="No ledger credit">Credits are issued with the assessment. Older agencies carry a legacy amount only until the integrator backfills the ledger.</Empty>
      </section>
    )
  }
  const state = creditLedgerState(credit)
  const mock = credit.payment_status === 'mock_paid' || (credit.payment_is_mock && credit.payment_status !== 'unpaid')
  const days = creditDaysLeft(credit)
  const svc = credit.eligible_service_key ? getService(credit.eligible_service_key) : null
  const realPaid = credit.payment_status === 'paid' && !credit.payment_is_mock
  return (
    <section id="credit" className="flex flex-col gap-4 rounded-[20px] border border-line p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base">Assessment credit</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={stateTone(state)}>{CREDIT_STATE_LABEL[state]}</Badge>
          {mock && <Badge tone="warn">simulated, not a real payment</Badge>}
        </div>
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-[14px] sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-grey-h">Original fee</dt><dd className="text-ink">{money(credit.original_fee_cents)}</dd></div>
        <div><dt className="text-grey-h">Payment status</dt><dd className="text-ink">{PAYMENT_STATUS_LABEL[credit.payment_status] ?? credit.payment_status}{credit.paid_at ? ` · ${date(credit.paid_at)}` : ''}</dd></div>
        <div><dt className="text-grey-h">Eligible build</dt><dd className="text-ink">{svc ? svc.name : 'Any qualifying build'}</dd></div>
        <div><dt className="text-grey-h">Expires</dt><dd className="text-ink">{date(credit.expires_at)}{days != null && state === 'available' ? ` · ${days} day${days === 1 ? '' : 's'} left` : ''}</dd></div>
        <div><dt className="text-grey-h">Credit amount</dt><dd className="text-ink">{money(credit.credit_cents)}</dd></div>
        <div><dt className="text-grey-h">Applied</dt><dd className="text-ink">{money(credit.applied_cents)}</dd></div>
        <div><dt className="text-grey-h">Remaining</dt><dd className="text-ink">{money(remainingCents(credit))}</dd></div>
        <div><dt className="text-grey-h">Term</dt><dd className="text-ink">{pricing.assessment.creditTermDays} days from issue</dd></div>
      </dl>
      <p className="text-[13px] text-grey-h max-w-[72ch]">
        The credit applies to a qualifying build within {pricing.assessment.creditTermDays} days of the assessment and never to a standalone service: Website Improvement is never credited.
        A mock payment is a simulation for demos and tests; the ledger refuses to apply a credit until a real payment is recorded.
      </p>
      {!realPaid && (
        <div className="flex flex-wrap gap-2">
          <form action={recordPaymentAction}>
            <input type="hidden" name="credit_id" value={credit.id} /><input type="hidden" name="mock" value="0" /><input type="hidden" name="back" value={back} />
            <button type="submit" className="btn sm">Record payment</button>
          </form>
          {credit.payment_status !== 'mock_paid' && (
            <form action={recordPaymentAction}>
              <input type="hidden" name="credit_id" value={credit.id} /><input type="hidden" name="mock" value="1" /><input type="hidden" name="back" value={back} />
              <button type="submit" className="btn ghost sm">Record mock payment (simulated)</button>
            </form>
          )}
        </div>
      )}
      {!compact && (
        <div>
          <h4 className="text-[14px] text-ink mb-2">Application history</h4>
          {applications.length === 0 ? <p className="text-[13px] text-grey-h">No applications yet. Engagements apply the credit when a build is sold.</p> : (
            <ul className="flex flex-col gap-2">
              {applications.map(a => (
                <li key={a.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line px-4 py-2 text-[14px] ${a.reversed_at ? 'opacity-70' : ''}`}>
                  <span className="text-ink">{money(a.amount_cents)} · {getService(a.service_key)?.name ?? a.service_key} · engagement {a.engagement_ref.slice(0, 8)}</span>
                  <span className="text-grey-h">{date(a.applied_at)}{a.reversed_at ? <> · <Badge tone="danger">reversed {date(a.reversed_at)}</Badge>{a.reversal_note ? ` ${a.reversal_note}` : ''}</> : null}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
