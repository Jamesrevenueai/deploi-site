import { calculateLeaks } from '@/lib/assessments/actions'
import { INPUT_STATUSES, INPUT_STATUS_LABEL, DEFAULT_STATUS, type InputKey, type LeakInputs } from '@/lib/leaks'
import { INPUT_LABEL, type Evidence } from '@/lib/assessments/evidence'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'

type FieldDef = { key: InputKey; hint: string; step?: string; required?: boolean }

const GROUPS: { title: string; blurb: string; fields: FieldDef[] }[] = [
  {
    title: 'Owner-reported averages', blurb: 'The five numbers from the owner. Mark each one measured when it came from an export, owner-reported when it was said in the room, assumed when nobody knew.',
    fields: [
      { key: 'avg_monthly_referrals', hint: 'All sources, last 6 months', required: true },
      { key: 'avg_referral_value_year', hint: 'Billed revenue a typical new client brings in a year', required: true },
      { key: 'aide_turnover_12mo', hint: 'Count, not percent', required: true },
      { key: 'open_shift_hours_week', hint: 'Hours posted as open in a typical week', step: '0.5', required: true },
      { key: 'evv_denial_rate', hint: 'Share of claims denied, e.g. 0.06 or 6', step: '0.01', required: true },
    ],
  },
  {
    title: 'Broader records (optional, turns a leak from illustrative into measured)', blurb: 'Counts over a period from the scheduler, EVV or billing export. Without them a leak is shown as illustrative with the frequency taken from the averages above and widened bounds.',
    fields: [
      { key: 'period_days', hint: 'Days the exports cover, e.g. 90' },
      { key: 'referrals_in_period', hint: 'Referrals received in the period' },
      { key: 'claims_in_period', hint: 'Claims submitted in the period' },
      { key: 'denied_claims_in_period', hint: 'Of those, denied' },
      { key: 'open_shifts_in_period', hint: 'Open or call-off shifts posted in the period' },
      { key: 'avg_shift_hours', hint: 'Hours in a typical open shift (assumed 4 when blank)', step: '0.5' },
    ],
  },
  {
    title: 'Revenue base and staff time', blurb: 'The denial leak is sized on billed revenue the agency supplies; it is never derived from the referral numbers. Staff hours become capacity released, never cash, unless an expenditure change is recorded.',
    fields: [
      { key: 'billed_revenue_year', hint: 'From the billing system or last year’s P&L' },
      { key: 'admin_hours_week', hint: 'Hours the office spends chasing shifts, referrals and EVV fixes by hand', step: '0.5' },
      { key: 'admin_hourly_cost', hint: 'Loaded cost per office hour (assumed $28 when blank)' },
      { key: 'recorded_expenditure_change_year', hint: 'Only if a vendor bill or payroll line actually changed' },
    ],
  },
]

export function LeakInputsForm({ assessmentId, inputs, evidence }: { assessmentId: string; inputs: Partial<LeakInputs> & Record<string, unknown>; evidence: Evidence }) {
  const val = (k: InputKey) => { const v = inputs?.[k]; return v == null ? '' : String(v) }
  return (
    <form action={calculateLeaks} className="flex flex-col gap-8">
      <input type="hidden" name="assessment_id" value={assessmentId} />
      {GROUPS.map(g => (
        <fieldset key={g.title} className="flex flex-col gap-4 rounded-[20px] border border-line p-4 md:p-5">
          <legend className="px-2 text-ink font-medium">{g.title}</legend>
          <p className="text-sm text-grey max-w-[70ch]">{g.blurb}</p>
          <div className="grid gap-4 md:grid-cols-2">
            {g.fields.map(f => {
              const ev = evidence.inputs[f.key]
              return (
                <div key={f.key} className="flex flex-col gap-2 rounded-2xl border border-line p-3">
                  <Field label={INPUT_LABEL[f.key]} hint={f.hint} htmlFor={f.key}>
                    <Input id={f.key} name={f.key} type="number" inputMode="decimal" min={0} step={f.step ?? '1'} defaultValue={val(f.key)} required={f.required} />
                  </Field>
                  <div className="grid gap-2 sm:grid-cols-[150px_1fr]">
                    <Field label="Status" htmlFor={`status_${f.key}`}>
                      <Select id={`status_${f.key}`} name={`status_${f.key}`} defaultValue={ev?.status ?? DEFAULT_STATUS[f.key]}>
                        {INPUT_STATUSES.map(s => <option key={s} value={s}>{INPUT_STATUS_LABEL[s]}</option>)}
                      </Select>
                    </Field>
                    <Field label="Source note" htmlFor={`source_${f.key}`}>
                      <Input id={`source_${f.key}`} name={`source_${f.key}`} defaultValue={ev?.source ?? ''} placeholder="e.g. scheduler export 2026-09" />
                    </Field>
                  </div>
                </div>
              )
            })}
          </div>
        </fieldset>
      ))}

      <fieldset id="evidence" className="flex flex-col gap-4 rounded-[20px] border border-line p-4 md:p-5">
        <legend className="px-2 text-ink font-medium">Evidence</legend>
        <p className="text-sm text-grey max-w-[70ch]">What the numbers rest on. Aggregate only: no patient information belongs here. {evidence.missing.length > 0 && <Badge tone="warn">{evidence.missing.length} inputs missing</Badge>}</p>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Evidence period start" htmlFor="period_start"><Input id="period_start" name="period_start" type="date" defaultValue={evidence.period_start ?? ''} /></Field>
          <Field label="Evidence period end" htmlFor="period_end"><Input id="period_end" name="period_end" type="date" defaultValue={evidence.period_end ?? ''} /></Field>
          <Field label="Sample size" hint="Rows in the export(s) the counts came from" htmlFor="sample_size"><Input id="sample_size" name="sample_size" type="number" min={0} defaultValue={evidence.sample_size ?? ''} /></Field>
          <Field label="Source reference" hint="e.g. scheduler export 2026-09, billing aging report" htmlFor="source_reference"><Input id="source_reference" name="source_reference" defaultValue={evidence.source_reference ?? ''} /></Field>
          <Field label="Supplied by" hint="Role or name of the person at the agency who gave the numbers" htmlFor="supplied_by"><Input id="supplied_by" name="supplied_by" defaultValue={evidence.supplied_by ?? ''} placeholder="Owner, office manager" /></Field>
          <Field label="Redacted traces" hint="Tick when trace step fields were left blank or aggregated on purpose" htmlFor="redacted">
            <label className="flex items-center gap-2 text-[15px] text-grey"><input id="redacted" name="redacted" type="checkbox" value="1" defaultChecked={evidence.redacted} /> Step details withheld or aggregated</label>
          </Field>
          <div className="md:col-span-2">
            <Field label="Staff notes" hint="Calculation notes, caveats, what to verify before the review meeting" htmlFor="staff_notes"><Textarea id="staff_notes" name="staff_notes" rows={3} defaultValue={evidence.staff_notes ?? ''} /></Field>
          </div>
        </div>
        {evidence.missing.length > 0 && (
          <p className="text-[13px] text-grey-h">Missing: {evidence.missing.map(k => INPUT_LABEL[k as InputKey] ?? k).join(', ')}.</p>
        )}
      </fieldset>

      <div><Button type="submit">Calculate the three leaks</Button></div>
    </form>
  )
}
