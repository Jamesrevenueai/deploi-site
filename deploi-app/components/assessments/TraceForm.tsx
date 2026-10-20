import { saveStep } from '@/lib/assessments/actions'
import { STEPS, TRACE_TITLES, elapsedLabel, type Trace, type TraceStepRow } from '@/lib/assessments/steps'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Badge } from '@/components/ui/Badge'

const toLocal = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** One trace: a card per step with its own save form. Elapsed time shown between consecutive steps. */
export function TraceForm({ assessmentId, trace, steps }: { assessmentId: string; trace: Trace; steps: TraceStepRow[] }) {
  const defs = STEPS[trace]
  const done = defs.filter(d => steps.some(s => s.trace === trace && s.step_key === d.key && s.occurred_at)).length
  return (
    <section id={trace} className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2>{TRACE_TITLES[trace]}</h2>
        <Badge tone={done === defs.length ? 'ok' : 'muted'}>{done} / {defs.length} steps</Badge>
      </div>
      <ol className="flex flex-col gap-3">
        {defs.map((d, i) => {
          const st = steps.find(s => s.trace === trace && s.step_key === d.key)
          const prev = i > 0 ? steps.find(s => s.trace === trace && s.step_key === defs[i - 1].key) : null
          const el = prev ? elapsedLabel(prev.occurred_at, st?.occurred_at ?? null) : null
          const base = `${trace}-${d.key}`
          return (
            <li key={d.key} id={base} className="rounded-[20px] border border-line p-4 md:p-5">
              <form action={saveStep} className="flex flex-col gap-3">
                <input type="hidden" name="assessment_id" value={assessmentId} />
                <input type="hidden" name="trace" value={trace} />
                <input type="hidden" name="step_key" value={d.key} />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="text-grey-h text-sm w-6">{String(i + 1).padStart(2, '0')}</span>
                    <h3 className="text-base">{d.title}</h3>
                  </div>
                  <div className="flex items-center gap-2">
                    {el && <Badge tone="muted">+{el} since previous</Badge>}
                    {st?.occurred_at ? <Badge tone="ok">saved</Badge> : <Badge tone="muted">open</Badge>}
                  </div>
                </div>
                <p className="text-sm text-grey">{d.prompt}</p>
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="When" htmlFor={`${base}-at`}><Input id={`${base}-at`} name="occurred_at" type="datetime-local" defaultValue={toLocal(st?.occurred_at)} /></Field>
                  <Field label="Who" htmlFor={`${base}-who`}><Input id={`${base}-who`} name="who" defaultValue={st?.who ?? ''} placeholder="Role or name" /></Field>
                  {d.outcome && (
                    <Field label={d.outcome.label} htmlFor={`${base}-outcome`}>
                      <Select id={`${base}-outcome`} name="outcome" defaultValue={st?.outcome ?? d.outcome.options[0]}>
                        {d.outcome.options.map(o => <option key={o} value={o}>{o}</option>)}
                      </Select>
                    </Field>
                  )}
                  <div className={d.outcome ? '' : 'md:col-span-2'}>
                    <Field label="What went wrong" htmlFor={`${base}-wrong`}><Textarea id={`${base}-wrong`} name="what_went_wrong" rows={2} defaultValue={st?.what_went_wrong ?? ''} placeholder="Nothing, or the thing that cost time or money" /></Field>
                  </div>
                </div>
                <div><button type="submit" className="btn ghost xs">Save step</button></div>
              </form>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
