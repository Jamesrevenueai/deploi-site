'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireRole, requestIp } from '../auth'
import { withUser } from '../db'
import { env } from '../env'
import { log } from '../log'
import { parseInputs, topLeaks, recommendedDoor } from '../leaks'
import { STEPS, traceFacts, type Trace } from './steps'
import { getAssessment, getSteps } from './queries'
import { buildReportPdf } from '../report/pdf'
import { putFile } from '../storage'

/** Lower bound of "$1,500–2,500" → 1500 */
export async function defaultFeeDollars() {
  const m = env.pricing.assessment.replace(/,/g, '').match(/\d+(\.\d+)?/)
  return m ? Number(m[0]) : 1500
}

/** Create the assessment: stage → assessment_sold, tenant row, credit, walkthrough. */
export async function createAssessment(formData: FormData) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const prospectId = String(formData.get('prospect_id') ?? '')
  const fee = Math.max(0, Number(formData.get('fee_dollars')) || 0)
  if (!prospectId) redirect('/staff/assessments/new?error=prospect-required')

  const id = await withUser(session, async db => {
    const p = await db.one<{ id: string; agency_name: string; city: string | null; county: string | null; state: string | null; agency_id: string | null }>(
      'select id, agency_name, city, county, state, agency_id from prospects where id = $1', [prospectId])
    if (!p) throw new Error('prospect not found')
    let agencyId = p.agency_id
    if (!agencyId) {
      const g = await db.one<{ id: string }>(
        'insert into agencies (name, city, county, state, prospect_id) values ($1,$2,$3,$4,$5) returning id',
        [p.agency_name, p.city, p.county, p.state ?? 'OH', p.id])
      agencyId = g!.id
      await db.query('update prospects set agency_id = $1 where id = $2', [agencyId, p.id])
    }
    // Item 6: credit_expires_at = assessment_sold_at + 60 days (assessment_credit_expires_at kept in sync for older readers).
    await db.query(
      `update agencies set assessment_credit_cents = $1, credit_expires_at = now() + interval '60 days', assessment_credit_expires_at = now() + interval '60 days',
         assessment_credit_applied_at = null, credit_expired = false where id = $2`,
      [Math.round(fee * 100), agencyId])
    await db.query("update prospects set stage = 'assessment_sold', assessment_sold_at = now() where id = $1 and stage not in ('assessment_sold','build_sold','retainer')", [p.id])
    await db.query('update prospects set assessment_sold_at = coalesce(assessment_sold_at, now()) where id = $1', [p.id])
    await db.query("insert into touches (prospect_id, channel, direction, subject, body, meta) values ($1,'call','outbound','Assessment sold',$2, '{}'::jsonb)", [p.id, `Operations Assessment booked, fee $${fee}`])
    const a = await db.one<{ id: string }>(
      "insert into assessments (prospect_id, agency_id, status, fee_cents) values ($1,$2,'in_progress',$3) returning id",
      [p.id, agencyId, Math.round(fee * 100)])
    return a!.id
  }, { ip })
  log.info('assessment.created', { id, prospect_id: prospectId })
  revalidatePath('/staff/assessments')
  revalidatePath('/staff/pipeline')
  redirect(`/staff/assessments/${id}`)
}

/** Upsert one trace step. */
export async function saveStep(formData: FormData) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const assessmentId = String(formData.get('assessment_id') ?? '')
  const trace = String(formData.get('trace') ?? '') as Trace
  const stepKey = String(formData.get('step_key') ?? '')
  const def = STEPS[trace]?.find(s => s.key === stepKey)
  if (!assessmentId || !def) redirect(`/staff/assessments/${assessmentId}`)
  const order = STEPS[trace].findIndex(s => s.key === stepKey)
  const occurredRaw = String(formData.get('occurred_at') ?? '').trim()
  const occurredAt = occurredRaw ? new Date(occurredRaw) : null
  const who = String(formData.get('who') ?? '').trim() || null
  const wrong = String(formData.get('what_went_wrong') ?? '').trim() || null
  const outcome = String(formData.get('outcome') ?? '').trim() || null
  const note = String(formData.get('note') ?? '').trim() || null

  await withUser(session, async db => {
    const a = await db.one<{ agency_id: string }>('select agency_id from assessments where id = $1', [assessmentId])
    if (!a) throw new Error('assessment not found')
    await db.query(
      `insert into trace_steps (assessment_id, agency_id, trace, step_key, step_order, occurred_at, who, what_went_wrong, outcome, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (assessment_id, trace, step_key) do update set occurred_at = excluded.occurred_at, who = excluded.who,
         what_went_wrong = excluded.what_went_wrong, outcome = excluded.outcome, note = excluded.note`,
      [assessmentId, a.agency_id, trace, stepKey, order, occurredAt && !isNaN(occurredAt.getTime()) ? occurredAt.toISOString() : null, who, wrong, outcome, note])
    await db.query("update assessments set status = case when status = 'draft' then 'in_progress' else status end where id = $1", [assessmentId])
  }, { ip })
  revalidatePath(`/staff/assessments/${assessmentId}`)
  redirect(`/staff/assessments/${assessmentId}#${trace}-${stepKey}`)
}

/** Save the five inputs, compute the three biggest leaks, pick the door. */
export async function calculateLeaks(formData: FormData) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const assessmentId = String(formData.get('assessment_id') ?? '')
  const inputs = parseInputs(Object.fromEntries(formData.entries()))
  await withUser(session, async db => {
    const steps = await getSteps(db, assessmentId)
    const leaks = topLeaks(inputs, traceFacts(steps))
    await db.query('update assessments set inputs = $1, leaks = $2, recommended_door = $3 where id = $4',
      [JSON.stringify(inputs), JSON.stringify(leaks), recommendedDoor(leaks), assessmentId])
  }, { ip })
  revalidatePath(`/staff/assessments/${assessmentId}`)
  redirect(`/staff/assessments/${assessmentId}/report`)
}

/** Render the PDF, store it under the agency, mark the assessment complete. */
export async function generateReport(formData: FormData) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const assessmentId = String(formData.get('assessment_id') ?? '')
  const bytes = await withUser(session, async db => {
    const a = await getAssessment(db, assessmentId)
    if (!a) throw new Error('assessment not found')
    const steps = await getSteps(db, assessmentId)
    const pdf = await buildReportPdf(a, steps)
    const path = `${a.agency_id}/assessment-${a.id}.pdf`
    await putFile(path, pdf, 'application/pdf')
    await db.query("update assessments set report_path = $1, report_generated_at = now(), status = 'complete' where id = $2", [path, a.id])
    return pdf.length
  }, { ip })
  log.info('assessment.report.generated', { id: assessmentId, bytes })
  revalidatePath(`/staff/assessments/${assessmentId}/report`)
  redirect(`/staff/assessments/${assessmentId}/report?generated=1`)
}

/** Mark the credit as applied (build sold inside the window). Callable from the pipeline. */
export async function applyCredit(agencyId: string) {
  const session = await requireRole('staff')
  await withUser(session, db => db.query(
    'update agencies set assessment_credit_applied_at = now() where id = $1 and assessment_credit_cents > 0 and assessment_credit_applied_at is null and (assessment_credit_expires_at is null or assessment_credit_expires_at >= now())',
    [agencyId]))
  revalidatePath(`/staff/agencies/${agencyId}`)
}
