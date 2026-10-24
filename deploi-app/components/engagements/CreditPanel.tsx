import { Field, Input, Select } from '@/components/ui/Field'
import { Badge } from '@/components/ui/Badge'
import { creditLedgerState, remainingCents, type CreditRow } from '@/lib/credit/ledger'
import { applyCreditAction } from '@/app/staff/engagements/actions'

const money = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US')
type Application = { id: string; credit_id: string; amount_cents: number; applied_at: string; reversed_at: string | null }

/** Apply an assessment credit from the ledger. Errors come back as banners on the page. */
export function CreditPanel({ engagementId, status, credits, applications, appliedCents }: { engagementId: string; status: string; credits: CreditRow[]; applications: Application[]; appliedCents: number }) {
  const usable = credits.filter(c => ['available', 'partially_applied'].includes(creditLedgerState(c)))
  const live = applications.filter(a => !a.reversed_at)
  return (
    <section className="flex flex-col gap-4 rounded-[20px] border border-line p-5 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg">Assessment credit</h2>
        <Badge tone={appliedCents ? 'ok' : 'muted'}>{appliedCents ? `${money(appliedCents)} applied` : 'none applied'}</Badge>
      </div>
      {credits.length === 0 ? <p className="text-[14px] text-grey-h">This agency has no credit in the ledger. A paid assessment issues one.</p> : (
        <ul className="flex flex-col gap-2 text-[14px]">
          {credits.map(c => { const s = creditLedgerState(c); return (
            <li key={c.id} className="flex flex-wrap items-center gap-2">
              <Badge tone={s === 'available' || s === 'partially_applied' ? 'ok' : s === 'expired' ? 'danger' : 'muted'}>{s.replace(/_/g, ' ')}</Badge>
              <span className="text-ink">{money(c.credit_cents)}</span><span>· {money(remainingCents(c))} remaining{c.expires_at ? ` · expires ${new Date(c.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}{c.payment_is_mock ? ' · mock payment, unusable' : ''}</span>
            </li>
          ) })}
        </ul>
      )}
      {live.length > 0 && <p className="text-[13px] text-grey-h">{live.length} application{live.length === 1 ? '' : 's'} on this engagement; reversals are recorded in the ledger, never deleted.</p>}
      {usable.length > 0 && status !== 'completed' && (
        <form action={applyCreditAction} className="grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
          <input type="hidden" name="id" value={engagementId} />
          <Field label="Credit" htmlFor="credit_id"><Select id="credit_id" name="credit_id">{usable.map(c => <option key={c.id} value={c.id}>{money(remainingCents(c))} remaining of {money(c.credit_cents)}</option>)}</Select></Field>
          <Field label="Amount ($)" htmlFor="amount_dollars"><Input id="amount_dollars" name="amount_dollars" type="number" min={1} step="1" defaultValue={Math.round(remainingCents(usable[0]) / 100)} required /></Field>
          <button type="submit" className="btn ghost sm">Apply credit</button>
        </form>
      )}
    </section>
  )
}
