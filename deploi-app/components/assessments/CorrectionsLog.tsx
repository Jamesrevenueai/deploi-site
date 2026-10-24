import { addCorrection } from '@/lib/assessments/actions'
import { INPUT_KEYS, type InputKey } from '@/lib/leaks'
import { INPUT_LABEL, type Evidence } from '@/lib/assessments/evidence'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Empty } from '@/components/ui/Empty'

const when = (iso: string) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')

/** Customer corrections: what the agency changed after seeing the numbers, by whom, when. Input corrections recalculate the leaks. */
export function CorrectionsLog({ assessmentId, evidence }: { assessmentId: string; evidence: Evidence }) {
  const rows = [...evidence.corrections].reverse()
  return (
    <section id="corrections" className="flex flex-col gap-4 rounded-[20px] border border-line p-4 md:p-5">
      <div>
        <h3 className="text-base">Customer corrections</h3>
        <p className="text-sm text-grey max-w-[70ch]">When the owner corrects a number, log it here with who said it. A correction to a leak input updates the input and recalculates the leaks; the previous value stays in the log.</p>
      </div>
      {rows.length === 0 ? <Empty title="No corrections yet" /> : (
        <ul className="flex flex-col gap-2">
          {rows.map((c, i) => (
            <li key={`${c.at}-${i}`} className="rounded-2xl border border-line px-4 py-3 text-[14px]">
              <div className="text-ink font-medium">{INPUT_LABEL[c.field as InputKey] ?? c.field}: <span className="text-grey-h line-through">{c.previous || '—'}</span> → {c.corrected}</div>
              <div className="text-[13px] text-grey-h">by {c.by} · {when(c.at)}{c.recorded_by ? ` · logged by ${c.recorded_by}` : ''}{c.note ? ` · ${c.note}` : ''}</div>
            </li>
          ))}
        </ul>
      )}
      <form action={addCorrection} className="grid gap-3 md:grid-cols-2">
        <input type="hidden" name="assessment_id" value={assessmentId} />
        <Field label="Field" htmlFor="corr-field">
          <Select id="corr-field" name="field" defaultValue={INPUT_KEYS[0]}>
            {INPUT_KEYS.map(k => <option key={k} value={k}>{INPUT_LABEL[k]}</option>)}
            <option value="period">Evidence period</option>
            <option value="source_reference">Source reference</option>
            <option value="other">Other (describe in note)</option>
          </Select>
        </Field>
        <Field label="Corrected value" htmlFor="corr-corrected"><Input id="corr-corrected" name="corrected" required placeholder="e.g. 11" /></Field>
        <Field label="Corrected by" hint="Role or name at the agency" htmlFor="corr-by"><Input id="corr-by" name="by" required placeholder="Owner" /></Field>
        <Field label="Note" htmlFor="corr-note"><Textarea id="corr-note" name="note" rows={2} placeholder="Why it changed" /></Field>
        <div className="md:col-span-2"><button type="submit" className="btn ghost sm">Log correction</button></div>
      </form>
    </section>
  )
}
