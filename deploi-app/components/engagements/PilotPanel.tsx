import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Badge } from '@/components/ui/Badge'
import { getService } from '@/lib/catalog/services'
import { DECISIONS, DECISION_LABEL, pilotMeasureKeys, type PilotRow, type MeasurementRow } from '@/lib/pilots/queries'
import { SUPPORTED } from '@/lib/pilots/metrics'
import { savePilot, computePilotPeriod, decidePilot, saveManualMeasurement } from '@/app/staff/engagements/actions'

const fmt = (v: string | null, unit: string) => {
  if (v == null) return '—'
  const n = Number(v)
  if (unit === 'ratio') return `${Math.round(n * 100)}%`
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${unit}`.trim()
}
const date = (d: string | null) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')
const UNIT: Record<string, string> = { referral_response_time: 'minutes', exception_resolution_time: 'days', staff_handling_time: 'min / item', time_to_fill: 'minutes', applicant_first_contact_time: 'minutes' }

/** Define the pilot, compute baseline vs pilot, record the decision. */
export function PilotPanel({ engagementId, agencyId, serviceKey, pilot, measurements, names }: { engagementId: string; agencyId: string; serviceKey: string; pilot: PilotRow | null; measurements: MeasurementRow[]; names: Record<string, string> }) {
  const svc = getService(serviceKey)
  const keys = pilotMeasureKeys(serviceKey)
  const row = (key: string, period: 'baseline' | 'pilot') => measurements.find(m => m.metric_key === key && m.period === period)
  const unit = (key: string) => UNIT[key] ?? (SUPPORTED[key] ? 'ratio' : '')
  return (
    <section className="flex flex-col gap-5 rounded-[20px] border border-line p-5 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg">Pilot</h2>
        {pilot?.decision ? <Badge tone={pilot.decision === 'continue' || pilot.decision === 'expand' ? 'ok' : pilot.decision === 'stop' ? 'danger' : 'warn'}>{DECISION_LABEL[pilot.decision]}</Badge> : pilot ? <Badge tone="warn">no decision yet</Badge> : <Badge tone="muted">not defined</Badge>}
      </div>

      <form action={savePilot} className="grid gap-4 md:grid-cols-2">
        <input type="hidden" name="id" value={engagementId} /><input type="hidden" name="agency_id" value={agencyId} /><input type="hidden" name="service_key" value={serviceKey} />
        <Field label="Baseline start" htmlFor="baseline_start"><Input id="baseline_start" name="baseline_start" type="date" defaultValue={pilot?.baseline_start ?? ''} /></Field>
        <Field label="Baseline end" htmlFor="baseline_end"><Input id="baseline_end" name="baseline_end" type="date" defaultValue={pilot?.baseline_end ?? ''} /></Field>
        <Field label="Pilot start" htmlFor="starts_on"><Input id="starts_on" name="starts_on" type="date" defaultValue={pilot?.starts_on ?? ''} /></Field>
        <Field label="Pilot end" htmlFor="ends_on"><Input id="ends_on" name="ends_on" type="date" defaultValue={pilot?.ends_on ?? ''} /></Field>
        <Field label="Primary metric" htmlFor="primary_metric_key" hint="One of the service's success measures.">
          <Select id="primary_metric_key" name="primary_metric_key" defaultValue={pilot?.primary_metric_key ?? ''}>
            <option value="">Choose…</option>
            {(svc?.successMeasures ?? []).map(m => <option key={m.key} value={m.key}>{m.label}{SUPPORTED[m.key] ? '' : ' (manual)'}</option>)}
          </Select>
        </Field>
        <Field label="Review owner" htmlFor="review_owner"><Input id="review_owner" name="review_owner" defaultValue={pilot?.review_owner ?? ''} /></Field>
        <Field label="Scope" htmlFor="scope"><Textarea id="scope" name="scope" rows={2} defaultValue={pilot?.scope ?? ''} /></Field>
        <Field label="Sample description" htmlFor="sample_description"><Textarea id="sample_description" name="sample_description" rows={2} defaultValue={pilot?.sample_description ?? ''} /></Field>
        <Field label="Quality guardrails" htmlFor="quality_guardrails" hint="One per line."><Textarea id="quality_guardrails" name="quality_guardrails" rows={3} defaultValue={pilot?.quality_guardrails.join('\n') ?? ''} /></Field>
        <Field label="Data sources" htmlFor="data_sources" hint="One per line."><Textarea id="data_sources" name="data_sources" rows={3} defaultValue={pilot?.data_sources.join('\n') ?? ''} /></Field>
        <div className="md:col-span-2"><button type="submit" className="btn ghost sm">{pilot ? 'Save pilot' : 'Define pilot'}</button></div>
      </form>

      {pilot && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <form action={computePilotPeriod}><input type="hidden" name="id" value={engagementId} /><input type="hidden" name="period" value="baseline" /><button type="submit" className="btn ghost sm" disabled={!pilot.baseline_start || !pilot.baseline_end}>Compute baseline</button></form>
            <form action={computePilotPeriod}><input type="hidden" name="id" value={engagementId} /><input type="hidden" name="period" value="pilot" /><button type="submit" className="btn ghost sm" disabled={!pilot.starts_on || !pilot.ends_on}>Compute pilot</button></form>
            <span className="text-[13px] text-grey-h">Baseline {date(pilot.baseline_start)} – {date(pilot.baseline_end)} · Pilot {date(pilot.starts_on)} – {date(pilot.ends_on)}</span>
          </div>
          <div className="table-wrap">
            <table className="dg-table">
              <thead><tr><th>Measure</th><th>Baseline</th><th>Pilot</th><th>Method</th></tr></thead>
              <tbody>
                {keys.map(k => {
                  const b = row(k.key, 'baseline'); const p = row(k.key, 'pilot'); const u = unit(k.key)
                  const cell = (m: MeasurementRow | undefined) => m ? (
                    <div>
                      <div className="text-ink">{fmt(m.value, u)}{m.source === 'manual' && <span className="ml-1 text-[12px] text-grey-h">manual</span>}</div>
                      <div className="text-[12px] text-grey-h">{m.numerator != null && m.denominator != null ? `${Number(m.numerator)} / ${Number(m.denominator)} · ` : ''}n = {m.sample_size ?? 0}</div>
                      {m.missing_data_note && <div className="text-[12px] text-warn">{m.missing_data_note}</div>}
                    </div>
                  ) : <span className="text-grey-h">not computed</span>
                  return (
                    <tr key={k.key}>
                      <td className="ink">{k.label}{pilot.primary_metric_key === k.key && <span className="ml-2"><Badge tone="ok">primary</Badge></span>}{!k.supported && <span className="ml-2"><Badge tone="muted">manual</Badge></span>}</td>
                      <td>{cell(b)}</td><td>{cell(p)}</td>
                      <td className="max-w-[32ch] text-[13px]">{SUPPORTED[k.key] ? (b?.missing_data_note || p ? '' : '') : ''}{svc?.successMeasures.find(m => m.key === k.key)?.definition ?? (k.key === 'staff_handling_time' ? 'Manual entry by the review owner.' : k.key === 'failed_actions' ? 'failed ÷ attempted; simulated never counts.' : k.key === 'corrections_required' ? 'edited before approval ÷ decided.' : 'decided by a person ÷ decided.')}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <form action={saveManualMeasurement} className="grid gap-3 rounded-[16px] border border-line p-4 md:grid-cols-[1fr_1fr_1fr_1fr_auto] md:items-end">
            <input type="hidden" name="id" value={engagementId} />
            <Field label="Manual measure" htmlFor="metric_key"><Select id="metric_key" name="metric_key">{keys.filter(k => !k.supported || k.key === 'staff_handling_time').map(k => <option key={k.key} value={k.key}>{k.label}</option>)}</Select></Field>
            <Field label="Period" htmlFor="period"><Select id="period" name="period"><option value="baseline">Baseline</option><option value="pilot">Pilot</option></Select></Field>
            <Field label="Value" htmlFor="value"><Input id="value" name="value" type="number" step="0.1" min={0} required /></Field>
            <Field label="Sample size" htmlFor="sample_size"><Input id="sample_size" name="sample_size" type="number" min={0} /></Field>
            <button type="submit" className="btn ghost sm">Record</button>
            <input type="hidden" name="note" value="manual entry" />
          </form>
          <form action={decidePilot} className="grid gap-3 rounded-[16px] border border-line p-4 md:grid-cols-[auto_1fr_auto] md:items-end">
            <input type="hidden" name="id" value={engagementId} />
            <Field label="Decision" htmlFor="decision"><Select id="decision" name="decision" defaultValue={pilot.decision ?? 'continue'}>{DECISIONS.map(d => <option key={d} value={d}>{DECISION_LABEL[d]}</option>)}</Select></Field>
            <Field label="Note" htmlFor="decision_note"><Input id="decision_note" name="note" defaultValue={pilot.decision_note ?? ''} placeholder="What the numbers showed and what changes" /></Field>
            <button type="submit" className="btn sm">Record decision</button>
            {pilot.decided_at && <p className="md:col-span-3 text-[13px] text-grey-h">Last decision {DECISION_LABEL[pilot.decision!]} on {date(pilot.decision_date)}{pilot.decided_by ? ` by ${names[pilot.decided_by] ?? 'staff'}` : ''}{pilot.decision_note ? ` · ${pilot.decision_note}` : ''}. Only Continue or Expand opens the move to Active.</p>}
          </form>
        </>
      )}
    </section>
  )
}
