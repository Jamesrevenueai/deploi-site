import { calculateLeaks } from '@/lib/assessments/actions'
import { Field, Input } from '@/components/ui/Field'
import { Button } from '@/components/ui/Button'

const FIELDS: { key: string; label: string; hint: string; step?: string }[] = [
  { key: 'avg_monthly_referrals', label: 'Average monthly referrals', hint: 'All sources, last 6 months' },
  { key: 'avg_referral_value_year', label: 'Average referral value per year ($)', hint: 'Billed revenue a typical new client brings in a year' },
  { key: 'aide_turnover_12mo', label: 'Aides who left in the last 12 months', hint: 'Count, not percent' },
  { key: 'open_shift_hours_week', label: 'Open-shift hours per week', hint: 'Hours posted as open in a typical week', step: '0.5' },
  { key: 'evv_denial_rate', label: 'EVV / auth denial rate', hint: 'Share of claims denied, e.g. 0.06 or 6', step: '0.01' },
]

export function LeakInputsForm({ assessmentId, inputs }: { assessmentId: string; inputs: Record<string, number> }) {
  return (
    <form action={calculateLeaks} className="flex flex-col gap-4">
      <input type="hidden" name="assessment_id" value={assessmentId} />
      <div className="grid gap-4 md:grid-cols-2">
        {FIELDS.map(f => (
          <Field key={f.key} label={f.label} hint={f.hint} htmlFor={f.key}>
            <Input id={f.key} name={f.key} type="number" inputMode="decimal" min={0} step={f.step ?? '1'} defaultValue={inputs?.[f.key] ?? ''} required />
          </Field>
        ))}
      </div>
      <div><Button type="submit">Calculate the three leaks</Button></div>
    </form>
  )
}
