'use client'
import { useActionState, useEffect, useState } from 'react'
import { Sheet } from '@/components/ui/Sheet'
import { Badge } from '@/components/ui/Badge'
import { Field, Textarea } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { RULE_LABELS, type ExceptionRule } from '@/lib/evv/types'
import { windowTone, windowLabel } from '@/lib/evv/window'
import type { ExceptionRow } from '@/lib/evv/queries'
import type { ActionResult } from '@/app/staff/evv/actions'

type Actions = {
  correct: (s: ActionResult | null, f: FormData) => Promise<ActionResult>
  dismiss: (s: ActionResult | null, f: FormData) => Promise<ActionResult>
  reopen: (f: FormData) => Promise<void>
}

const fmt = (iso: string | null, tz: string) => iso ? new Date(iso).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
const sevTone = (s: string) => (s === 'high' ? 'danger' : s === 'medium' ? 'warn' : 'muted') as 'danger' | 'warn' | 'muted'

export function ExceptionTable({ rows, status, actions, showAgency }: { rows: ExceptionRow[]; status: 'open' | 'corrected' | 'dismissed'; actions: Actions; showAgency?: boolean }) {
  const [active, setActive] = useState<{ row: ExceptionRow; mode: 'correct' | 'dismiss' } | null>(null)
  return (
    <>
      <div className="table-wrap hidden md:block">
        <table className="dg-table">
          <thead>
            <tr>
              <th>Window</th><th>Rule</th><th>Detail</th><th>Visit</th>{showAgency && <th>Agency</th>}<th>Aide</th><th>Client</th><th>Severity</th><th>{status === 'open' ? '' : 'Note'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td><WindowClock days={r.days_left} status={status} source={r.rule_source} /></td>
                <td className="ink">{RULE_LABELS[r.rule as ExceptionRule] ?? r.rule}</td>
                <td className="max-w-[34ch]">{r.detail}</td>
                <td className="whitespace-nowrap">{fmt(r.scheduled_start ?? r.actual_start, r.timezone)}<div className="text-[12px] text-grey-h">{r.vendor_visit_key ?? '—'} · {r.service_code}</div></td>
                {showAgency && <td>{r.agency_name}</td>}
                <td>{r.aide_initials ?? '—'}</td>
                <td>{r.client_initials ?? '—'}</td>
                <td><Badge tone={sevTone(r.severity)}>{r.severity}</Badge></td>
                <td className="whitespace-nowrap">
                  {status === 'open' ? (
                    <span className="flex gap-2">
                      <button className="btn ghost xs" onClick={() => setActive({ row: r, mode: 'correct' })}><Icon name="check" size={14} />Corrected</button>
                      <button className="btn ghost xs" onClick={() => setActive({ row: r, mode: 'dismiss' })}><Icon name="skip" size={14} />Dismiss</button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-2 text-[13px]"><span className="max-w-[28ch] truncate" title={r.correction_note ?? ''}>{r.correction_note}</span>
                      <form action={actions.reopen}><input type="hidden" name="id" value={r.id} /><button className="btn ghost xs" type="submit">Reopen</button></form>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 md:hidden">
        {rows.map(r => (
          <li key={r.id} className="rounded-2xl border border-line p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="text-ink font-medium leading-tight">{RULE_LABELS[r.rule as ExceptionRule] ?? r.rule}</div>
              <WindowClock days={r.days_left} status={status} source={r.rule_source} />
            </div>
            <p className="mt-1 text-[14px]">{r.detail}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-grey-h">
              <span>{fmt(r.scheduled_start ?? r.actual_start, r.timezone)}</span><span>·</span>
              <span>{r.service_code}</span><span>·</span>
              <span>aide {r.aide_initials ?? '—'}</span><span>·</span>
              <span>client {r.client_initials ?? '—'}</span>
              <Badge tone={sevTone(r.severity)}>{r.severity}</Badge>
            </div>
            {status === 'open' ? (
              <div className="mt-3 flex gap-2">
                <button className="btn ghost sm flex-1" onClick={() => setActive({ row: r, mode: 'correct' })}><Icon name="check" size={14} />Corrected</button>
                <button className="btn ghost sm" onClick={() => setActive({ row: r, mode: 'dismiss' })}><Icon name="skip" size={14} />Dismiss</button>
              </div>
            ) : (
              <div className="mt-3 flex items-center justify-between gap-3 text-[13px]"><span className="truncate">{r.correction_note}</span>
                <form action={actions.reopen}><input type="hidden" name="id" value={r.id} /><button className="btn ghost xs" type="submit">Reopen</button></form>
              </div>
            )}
          </li>
        ))}
      </ul>

      {active && <FixSheet row={active.row} mode={active.mode} action={active.mode === 'correct' ? actions.correct : actions.dismiss} onClose={() => setActive(null)} />}
    </>
  )
}

/** Deadline chip. `days` null means no rule set matched: the label says "deadline not configured", never a number. */
function WindowClock({ days, status, source }: { days: number | null; status: string; source?: string }) {
  if (status !== 'open') return <Badge tone="muted">{status}</Badge>
  const tone = windowTone(days)
  return <span title={source}><Badge tone={tone === 'none' ? 'none' : tone}><Icon name="clock" size={13} />{windowLabel(days)}</Badge></span>
}

function FixSheet({ row, mode, action, onClose }: { row: ExceptionRow; mode: 'correct' | 'dismiss'; action: Actions['correct']; onClose: () => void }) {
  const [state, formAction, pending] = useActionState(action, null)
  useEffect(() => { if (state?.ok) onClose() }, [state, onClose])
  return (
    <Sheet open onClose={onClose} title={mode === 'correct' ? 'Mark corrected in vendor system' : 'Dismiss exception'}>
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="id" value={row.id} />
        <div className="text-[15px]"><span className="text-ink font-medium">{RULE_LABELS[row.rule as ExceptionRule] ?? row.rule}</span><br />{row.detail}</div>
        <Field label={mode === 'correct' ? 'What was corrected, and where' : 'Why this is not an exception'} htmlFor="note" hint="Required. Shows in the audit trail and the morning report. The original visit evidence is kept in the revision history.">
          <Textarea id="note" name="note" required minLength={3} placeholder={mode === 'correct' ? 'e.g. Added clock-out 2:05 PM in Sandata visit maintenance' : 'e.g. Duplicate of vendor ticket 4411'} />
        </Field>
        {state && !state.ok && <div className="text-danger text-[14px]">{state.error}</div>}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>{pending ? 'Saving…' : mode === 'correct' ? 'Mark corrected' : 'Dismiss'}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Sheet>
  )
}
