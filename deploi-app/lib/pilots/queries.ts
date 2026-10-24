import type { Db } from '../db'
import { getService } from '../catalog/services'
import { computeMeasure, GENERIC_KEYS, SUPPORTED, ymdOf, type Period, type Measurement } from './metrics'

export const DECISIONS = ['continue', 'revise', 'expand', 'pause', 'stop'] as const
export type PilotDecision = (typeof DECISIONS)[number]
export const DECISION_LABEL: Record<PilotDecision, string> = { continue: 'Continue', revise: 'Revise', expand: 'Expand', pause: 'Pause', stop: 'Stop' }

export type PilotRow = {
  id: string; engagement_id: string; agency_id: string; starts_on: string | null; ends_on: string | null; primary_workflow: string; scope: string | null; sample_description: string | null
  baseline_start: string | null; baseline_end: string | null; primary_metric_key: string | null; quality_guardrails: string[]; data_sources: string[]; review_owner: string | null
  decision_date: string | null; decision: PilotDecision | null; decision_note: string | null; decided_by: string | null; decided_at: string | null; created_at: string; updated_at: string
}
export type MeasurementRow = {
  id: string; pilot_id: string; agency_id: string; metric_key: string; period: 'baseline' | 'pilot'; period_start: string; period_end: string
  numerator: string | null; denominator: string | null; value: string | null; sample_size: number | null; missing_data_note: string | null; source: string; computed_at: string; computed_by: string | null
}

export class PilotError extends Error { constructor(public code: 'not_found' | 'invalid_metric' | 'invalid_dates' | 'no_period' | 'invalid_decision', msg: string) { super(msg); this.name = 'PilotError' } }

const DATE_FIELDS = ['starts_on', 'ends_on', 'baseline_start', 'baseline_end', 'decision_date'] as const
function normalizePilot(p: PilotRow | null): PilotRow | null {
  if (!p) return null
  for (const k of DATE_FIELDS) (p as Record<string, unknown>)[k] = ymdOf(p[k])
  return p
}

export async function getPilot(db: Db, engagementId: string) {
  return normalizePilot(await db.one<PilotRow>('select * from pilots where engagement_id = $1', [engagementId]))
}

export async function listMeasurements(db: Db, pilotId: string) {
  const rows = await db.query<MeasurementRow>('select * from pilot_measurements where pilot_id = $1 order by metric_key, period', [pilotId])
  return rows.map(r => ({ ...r, period_start: ymdOf(r.period_start)!, period_end: ymdOf(r.period_end)! }))
}

export type PilotInput = { startsOn: string | null; endsOn: string | null; scope: string | null; sampleDescription: string | null; baselineStart: string | null; baselineEnd: string | null; primaryMetricKey: string | null; qualityGuardrails: string[]; dataSources: string[]; reviewOwner: string | null }

const validDate = (d: string | null) => d == null || /^\d{4}-\d{2}-\d{2}$/.test(d)

export async function upsertPilot(db: Db, input: { engagementId: string; agencyId: string; serviceKey: string } & PilotInput) {
  const svc = getService(input.serviceKey)
  if (input.primaryMetricKey && !svc?.successMeasures.some(m => m.key === input.primaryMetricKey)) throw new PilotError('invalid_metric', 'primary metric must be one of the service success measures')
  for (const d of [input.startsOn, input.endsOn, input.baselineStart, input.baselineEnd]) if (!validDate(d)) throw new PilotError('invalid_dates', 'dates must be YYYY-MM-DD')
  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) throw new PilotError('invalid_dates', 'pilot end is before start')
  if (input.baselineStart && input.baselineEnd && input.baselineEnd < input.baselineStart) throw new PilotError('invalid_dates', 'baseline end is before start')
  const r = await db.one<{ id: string }>(
    `insert into pilots (engagement_id, agency_id, primary_workflow, starts_on, ends_on, scope, sample_description, baseline_start, baseline_end, primary_metric_key, quality_guardrails, data_sources, review_owner)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (engagement_id) do update set starts_on = excluded.starts_on, ends_on = excluded.ends_on, scope = excluded.scope, sample_description = excluded.sample_description,
       baseline_start = excluded.baseline_start, baseline_end = excluded.baseline_end, primary_metric_key = excluded.primary_metric_key, quality_guardrails = excluded.quality_guardrails,
       data_sources = excluded.data_sources, review_owner = excluded.review_owner
     returning id`,
    [input.engagementId, input.agencyId, input.serviceKey, input.startsOn, input.endsOn, input.scope, input.sampleDescription, input.baselineStart, input.baselineEnd, input.primaryMetricKey,
     JSON.stringify(input.qualityGuardrails), JSON.stringify(input.dataSources), input.reviewOwner])
  return r!.id
}

/** The measures a pilot reports: the service's success measures plus the generic operating measures. */
export function pilotMeasureKeys(serviceKey: string): { key: string; label: string; supported: boolean }[] {
  const svc = getService(serviceKey)
  const own = (svc?.successMeasures ?? []).map(m => ({ key: m.key, label: m.label, supported: Boolean(SUPPORTED[m.key]) }))
  const generic = GENERIC_KEYS.filter(k => !own.some(o => o.key === k)).map(k => ({ key: k, label: SUPPORTED[k].label, supported: true }))
  return [...own, ...generic]
}

/** Compute and store every measure for one period of the pilot. */
export async function computePeriod(db: Db, pilot: PilotRow, period: 'baseline' | 'pilot', actorId: string | null) {
  const p: Period | null = period === 'baseline'
    ? (pilot.baseline_start && pilot.baseline_end ? { start: pilot.baseline_start, end: pilot.baseline_end } : null)
    : (pilot.starts_on && pilot.ends_on ? { start: pilot.starts_on, end: pilot.ends_on } : null)
  if (!p) throw new PilotError('no_period', `${period} dates are not set`)
  const out: Measurement[] = []
  for (const m of pilotMeasureKeys(pilot.primary_workflow)) {
    const r = await computeMeasure(db, m.key, m.label, pilot.agency_id, p)
    if (m.key === 'staff_handling_time') {
      // manual measure: keep any value a person entered, only refresh the note
      const existing = await db.one<{ source: string }>('select source from pilot_measurements where pilot_id = $1 and metric_key = $2 and period = $3', [pilot.id, m.key, period])
      if (existing?.source === 'manual') { out.push(r); continue }
    }
    await db.query(
      `insert into pilot_measurements (pilot_id, agency_id, metric_key, period, period_start, period_end, numerator, denominator, value, sample_size, missing_data_note, source, computed_at, computed_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'computed',now(),$12)
       on conflict (pilot_id, metric_key, period) do update set period_start = excluded.period_start, period_end = excluded.period_end, numerator = excluded.numerator, denominator = excluded.denominator,
         value = excluded.value, sample_size = excluded.sample_size, missing_data_note = excluded.missing_data_note, source = 'computed', computed_at = now(), computed_by = excluded.computed_by`,
      [pilot.id, pilot.agency_id, m.key, period, p.start, p.end, r.numerator, r.denominator, r.value, r.sample_size, r.missing_data_note, actorId])
    out.push(r)
  }
  return out
}

export async function recordManualMeasurement(db: Db, input: { pilot: PilotRow; metricKey: string; period: 'baseline' | 'pilot'; value: number; sampleSize: number | null; note: string | null; actorId: string | null }) {
  const p = input.period === 'baseline' ? { start: input.pilot.baseline_start, end: input.pilot.baseline_end } : { start: input.pilot.starts_on, end: input.pilot.ends_on }
  if (!p.start || !p.end) throw new PilotError('no_period', `${input.period} dates are not set`)
  await db.query(
    `insert into pilot_measurements (pilot_id, agency_id, metric_key, period, period_start, period_end, value, sample_size, missing_data_note, source, computed_at, computed_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',now(),$10)
     on conflict (pilot_id, metric_key, period) do update set value = excluded.value, sample_size = excluded.sample_size, missing_data_note = excluded.missing_data_note, source = 'manual', computed_at = now(), computed_by = excluded.computed_by`,
    [input.pilot.id, input.pilot.agency_id, input.metricKey, input.period, p.start, p.end, input.value, input.sampleSize, input.note, input.actorId])
}

export async function recordDecision(db: Db, input: { pilotId: string; decision: string; note: string | null; actorId: string | null }) {
  if (!(DECISIONS as readonly string[]).includes(input.decision)) throw new PilotError('invalid_decision', 'decision must be continue, revise, expand, pause or stop')
  const r = await db.query('update pilots set decision = $2, decision_note = $3, decided_by = $4, decided_at = now(), decision_date = current_date where id = $1 returning id', [input.pilotId, input.decision, input.note, input.actorId])
  if (!r.length) throw new PilotError('not_found', 'pilot not found')
}
