import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Field'
import { DEFAULT_ITEMS } from '@/lib/onboarding/checklist'
import type { Readiness } from '@/lib/onboarding/readiness'
import { INPUT_METHOD_LABEL } from '@/lib/engagements/defaults'
import { toggleItem, testInput } from '@/app/staff/engagements/actions'

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '')

/** Onboarding checklist with who/when, per-dimension readiness and the live input-source test. */
export function ChecklistPanel({ engagementId, inputMethod, readiness, names }: { engagementId: string; inputMethod: string | null; readiness: Readiness; names: Record<string, string> }) {
  const canTest = inputMethod === 'email_inbox' || inputMethod === 'sms_reply'
  return (
    <section className="flex flex-col gap-4 rounded-[20px] border border-line p-5 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg">Onboarding and readiness</h2>
        <Badge tone={readiness.ready ? 'ok' : 'warn'}>{readiness.ready ? 'ready for pilot' : `${readiness.missing.length} required item${readiness.missing.length === 1 ? '' : 's'} open`}</Badge>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 text-[14px]">
        {readiness.dimensions.map(d => (
          <li key={d.dimension} className="flex items-center gap-2 rounded-[12px] border border-line px-3 py-2">
            <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${d.ready ? 'bg-ok' : 'bg-warn'}`} aria-hidden="true" />
            <span className="text-ink">{d.label}</span><span className="text-grey-h">{d.satisfied}/{d.required}</span>
          </li>
        ))}
      </ul>
      <ul className="divide-y divide-line">
        {readiness.items.map(i => {
          const def = DEFAULT_ITEMS.find(d => d.key === i.key)
          const simulated = Boolean(i.evidence && (i.evidence.simulated === true || i.evidence.mocked === true))
          return (
            <li key={i.key} className="flex flex-col gap-2 py-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-block h-3 w-3 shrink-0 rounded-full ${i.satisfied ? 'bg-ok' : 'bg-danger'}`} aria-label={i.satisfied ? 'satisfied' : 'open'} />
                  <span className="text-ink font-medium">{i.label}</span>
                  {simulated && <Badge tone="warn">simulated</Badge>}
                  {!i.required && <Badge tone="muted">optional</Badge>}
                </div>
                <div className="text-[13px] text-grey-h">{def?.help}</div>
                {i.reason && <div className="text-[13px] text-warn">{i.reason}</div>}
                {i.completed && <div className="text-[13px]">Completed {when(i.completed_at)}{i.completed_by ? ` by ${names[i.completed_by] ?? 'staff'}` : ''}{i.note ? ` · ${i.note}` : ''}</div>}
              </div>
              <form action={toggleItem} className="flex flex-wrap items-center gap-2 md:shrink-0">
                <input type="hidden" name="id" value={engagementId} /><input type="hidden" name="key" value={i.key} /><input type="hidden" name="done" value={i.completed ? '0' : '1'} />
                {!i.completed && <Input name="note" placeholder="Note" aria-label={`Note for ${i.label}`} className="input" style={{ minHeight: 36, padding: '6px 10px', fontSize: 14, maxWidth: 200 }} />}
                <button type="submit" className="btn ghost xs">{i.completed ? 'Reopen' : 'Mark complete'}</button>
              </form>
            </li>
          )
        })}
      </ul>
      <form action={testInput} className="flex flex-col gap-2 rounded-[16px] border border-line p-4 md:flex-row md:items-center md:justify-between">
        <input type="hidden" name="id" value={engagementId} /><input type="hidden" name="input_method" value={inputMethod ?? ''} />
        <div className="text-[14px]">
          <div className="text-ink font-medium">Test input source · {inputMethod ? INPUT_METHOD_LABEL[inputMethod] ?? inputMethod : 'no input method'}</div>
          <div className="text-grey-h">{canTest ? 'Sends one test through the adapter to you. With no provider credentials the send is mocked and recorded as simulated; it never satisfies the gate.' : 'CSV, webhook and manual input are verified by a real import; mark the item once one has landed.'}</div>
        </div>
        <button type="submit" className="btn ghost sm" disabled={!canTest}>Run test</button>
      </form>
    </section>
  )
}
