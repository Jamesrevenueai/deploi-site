import { Field, Input, Select } from '@/components/ui/Field'
import { Badge } from '@/components/ui/Badge'
import { STATUS_LABEL, STATUS_TONE, ACCEPTANCE_METHODS, type EngagementStatus } from '@/lib/engagements/states'
import type { EngagementView, TransitionRow } from '@/lib/engagements/types'
import { moveStatus } from '@/app/staff/engagements/actions'

const METHOD_LABEL: Record<string, string> = { email: 'Email reply', signed_pdf: 'Signed PDF', verbal_confirmed: 'Verbal, confirmed in writing', portal: 'Portal acceptance' }
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

type Available = { to: EngagementStatus; unmet: string[] }

/** Transition buttons (legal moves only), the acceptance-evidence form, and the history. */
export function TransitionPanel({ e, available, history }: { e: EngagementView; available: Available[]; history: TransitionRow[] }) {
  const ev = e.acceptance_evidence
  return (
    <section className="flex flex-col gap-4 rounded-[20px] border border-line p-5 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg">Status</h2>
        <Badge tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Badge>
      </div>
      {ev ? (
        <p className="text-[14px]"><span className="text-ink">Acceptance recorded:</span> {METHOD_LABEL[ev.method] ?? ev.method} · {ev.reference || 'no reference'} · by {ev.accepted_by} on {when(ev.accepted_at)}.</p>
      ) : (
        <p className="text-[14px] text-grey-h">No acceptance recorded. A status change alone never proves acceptance; record how the customer accepted below.</p>
      )}
      {available.length === 0 ? <p className="text-[14px] text-grey-h">This engagement is completed; no further transitions.</p> : (
        <ul className="flex flex-col gap-3">
          {available.map(a => (
            <li key={a.to} className="rounded-[16px] border border-line p-4">
              {a.to === 'accepted' ? (
                <form action={moveStatus} className="grid gap-3 md:grid-cols-2">
                  <input type="hidden" name="id" value={e.id} /><input type="hidden" name="to" value="accepted" />
                  <div className="md:col-span-2 text-ink font-medium">Mark accepted · acceptance evidence required</div>
                  <Field label="How did the customer accept?" htmlFor="method"><Select id="method" name="method" required>{ACCEPTANCE_METHODS.map(m => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</Select></Field>
                  <Field label="Reference" htmlFor="reference" hint="Message id, file name or portal reference. Never a password."><Input id="reference" name="reference" required /></Field>
                  <Field label="Accepted by" htmlFor="accepted_by"><Input id="accepted_by" name="accepted_by" required /></Field>
                  <Field label="Accepted at" htmlFor="accepted_at"><Input id="accepted_at" name="accepted_at" type="datetime-local" required /></Field>
                  <Field label="Note" htmlFor="note_accept"><Input id="note_accept" name="note" /></Field>
                  <div className="flex items-end"><button type="submit" className="btn sm">Record acceptance and mark accepted</button></div>
                </form>
              ) : (
                <form action={moveStatus} className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                  <input type="hidden" name="id" value={e.id} /><input type="hidden" name="to" value={a.to} />
                  <div className="min-w-0 flex-1">
                    <div className="text-ink font-medium">Move to {STATUS_LABEL[a.to]}</div>
                    {a.unmet.length > 0 ? <div className="text-[13px] text-warn">Blocked: {a.unmet.join(' · ')}</div> : <div className="text-[13px] text-grey-h">{GATE_NOTE[a.to] ?? 'No gate.'}</div>}
                    <Input name="note" placeholder="Note (optional)" aria-label="Note" className="mt-2" />
                  </div>
                  <button type="submit" className="btn ghost sm" disabled={a.unmet.length > 0}>{STATUS_LABEL[a.to]}</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3 className="text-base mt-2">History</h3>
      {history.length === 0 ? <p className="text-[14px] text-grey-h">No transitions yet.</p> : (
        <ol className="flex flex-col gap-2 text-[14px]">
          {history.map(t => (
            <li key={t.id} className="flex flex-wrap items-baseline gap-x-2 border-b border-line pb-2 last:border-b-0">
              <span className="text-grey-h whitespace-nowrap">{when(t.at)}</span>
              <span className="text-ink">{t.from_status ? `${STATUS_LABEL[t.from_status as EngagementStatus] ?? t.from_status} → ` : ''}{STATUS_LABEL[t.to_status as EngagementStatus] ?? t.to_status}</span>
              {t.note && <span>· {t.note}</span>}
              {t.evidence && 'gate' in t.evidence && <Badge tone="muted">gate passed</Badge>}
              {t.evidence && 'method' in t.evidence && <Badge tone="ok">evidence</Badge>}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

const GATE_NOTE: Partial<Record<EngagementStatus, string>> = {
  building: 'Gate: agreements recorded and data access authorized.',
  testing: 'Gate: input source tested live (a simulated test does not count).',
  pilot: 'Gate: every required item, baseline captured, pilot approval, pilot dates and primary metric.',
  active: 'Gate: pilot decision Continue or Expand.',
  proposed: 'Sends the proposal; commercial terms stay editable until accepted.',
}
