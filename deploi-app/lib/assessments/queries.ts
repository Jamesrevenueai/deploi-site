import type { Db } from '../db'
import type { Leak } from '../leaks'
import type { TraceStepRow } from './steps'

export type AssessmentRow = {
  id: string
  prospect_id: string | null
  agency_id: string
  status: string
  inputs: Record<string, number>
  leaks: Leak[]
  recommended_door: 'growth' | 'staffing' | 'operations' | null
  report_path: string | null
  report_generated_at: string | null
  fee_cents: number
  created_at: string
  updated_at: string
  agency_name: string
  agency_city: string | null
  agency_state: string | null
  prospect_agency_name: string | null
  owner_name: string | null
  prospect_email: string | null
  prospect_stage: string | null
}

export const ASSESSMENT_SELECT = `
  select a.*, g.name as agency_name, g.city as agency_city, g.state as agency_state,
         p.agency_name as prospect_agency_name, p.owner_name, p.email as prospect_email, p.stage as prospect_stage
  from assessments a
  join agencies g on g.id = a.agency_id
  left join prospects p on p.id = a.prospect_id`

export async function listAssessments(db: Db) {
  return db.query<AssessmentRow>(`${ASSESSMENT_SELECT} order by a.updated_at desc`)
}

export async function getAssessment(db: Db, id: string) {
  const row = await db.one<AssessmentRow>(`${ASSESSMENT_SELECT} where a.id = $1`, [id])
  if (row) await db.auditRead('assessments', row.agency_id, [row.id])
  return row
}

export async function getSteps(db: Db, assessmentId: string) {
  return db.query<TraceStepRow>('select id, trace, step_key, step_order, occurred_at, who, what_went_wrong, outcome, note from trace_steps where assessment_id = $1 order by trace, step_order', [assessmentId])
}

export function leaksTotal(leaks: Leak[] | null | undefined) {
  return (leaks ?? []).reduce((s, l) => s + (Number(l.dollars_per_year) || 0), 0)
}
