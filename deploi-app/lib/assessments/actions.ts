'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireRole, requestIp } from '../auth'
import { withUser } from '../db'
import { log } from '../log'
import { parseInputs, topLeaks, recommendedDoor, INPUT_KEYS, type InputKey } from '../leaks'
import { STEPS, traceFacts, type Trace } from './steps'
import { getAssessment, getSteps } from './queries'
import { parseEvidence, evidenceFromForm, statusesFromEvidence, addCorrectionTo, missingInputs } from './evidence'
import { buildReportPdf } from '../report/pdf'
import { putFile } from '../storage'
import { getPricing } from '../catalog/pricing'
import { issueCredit, validEligibleServiceKey } from '../credit/ledger'

/** Lower bound of the published assessment range. */
export async function defaultFeeDollars() {
  return getPricing().assessment.min
}

/** Create the assessment: stage → assessment_sold, tenant row, ledger credit (unpaid until recorded), walkthrough. */
export async function createAssessment(formData: FormData) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const prospectId = String(formData.get('prospect_id') ?? '')
  const fee = Math.max(0, Number(formData.get('fee_dollars')) || 0)
  const creditRaw = formData.get('credit_dollars')
  const credit = creditRaw == null || String(creditRaw).trim() === '' ? fee : Math.max(0, Number(creditRaw) || 0)
  const eligible = validEligibleServiceKey(String(formData.get('eligible_service_key') ?? '') || null)
  if (!prospectId) redirect('/staff/assessments/new?error=prospect-required')
  if (credit > fee) redirect(`/staff/assessments/new?prospect=${prospectId}&error=credit-above-fee`)
  const termDays = getPricing().assessment.creditTermDays

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
    await db.query("update prospects set stage = 'assessment_sold', assessment_sold_at = now() where id = $1 and stage not in ('assessment_sold','build_sold','retainer')", [p.id])
    await db.query('update prospects set assessment_sold_at = coalesce(assessment_sold_at, now()) where id = $1', [p.id])
    await db.query("insert into touches (prospect_id, channel, direction, subject, body, meta) values ($1,'call','outbound','Assessment sold',$2, '{}'::jsonb)", [p.id, `Operations Assessment booked, fee $${fee}`])
    const a = await db.one<{ id: string }>(
      "insert into assessments (prospect_id, agency_id, status, fee_cents) values ($1,$2,'in_progress',$3) returning id",
      [p.id, agencyId, Math.round(fee * 100)])
    // The ledger is the truth; issueCredit mirrors the legacy agency columns for older readers.
    await issueCredit(db, { agencyId, assessmentId: a!.id, feeCents: Math.round(fee * 100), creditCents: Math.round(credit * 100), termDays, eligibleServiceKey: eligible, createdBy: session.uid, note: 'issued with the assessment; payment not yet recorded' })
    return a!.id
  }, { ip })
  log.info('assessment.created', { id, prospect_id: prospectId, term_days: termDays })
  revalidatePath('/staff/assessments')
  revalidatePath('/staff/pipeline')
  redirect(`/staff/assessments/${id}`)
}

/** Upsert one trace step. Every field is optional so a trace can be aggregate or redacted. */
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

/** Save the inputs with their statuses and the evidence panel, compute the three principal leaks, pick the door. */
export async function calculateLeaks(formData: FormData) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const assessmentId = String(formData.get('assessment_id') ?? '')
  const raw = Object.fromEntries(formData.entries())
  const inputs = parseInputs(raw)
  await withUser(session, async db => {
    const a = await getAssessment(db, assessmentId)
    if (!a) throw new Error('assessment not found')
    const evidence = evidenceFromForm(raw, parseEvidence(a.evidence), inputs)
    const steps = await getSteps(db, assessmentId)
    const leaks = topLeaks(inputs, traceFacts(steps), 3, statusesFromEvidence(evidence))
    await db.query('update assessments set inputs = $1, leaks = $2, evidence = $3, recommended_door = $4 where id = $5',
      [JSON.stringify(inputs), JSON.stringify(leaks), JSON.stringify(evidence), recommendedDoor(leaks), assessmentId])
  }, { ip })
  revalidatePath(`/staff/assessments/${assessmentId}`)
  redirect(`/staff/assessments/${assessmentId}/report`)
}

/** Log a customer correction. When the field is a leak input the value is applied and the leaks recalculated. */
export async function addCorrection(formData: FormData) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const assessmentId = String(formData.get('assessment_id') ?? '')
  const field = String(formData.get('field') ?? '').trim()
  const corrected = String(formData.get('corrected') ?? '').trim()
  const by = String(formData.get('by') ?? '').trim()
  const note = String(formData.get('note') ?? '').trim() || null
  const back = `/staff/assessments/${assessmentId}`
  if (!assessmentId || !field || !corrected || !by) redirect(`${back}?error=correction-incomplete#evidence`)
  await withUser(session, async db => {
    const a = await getAssessment(db, assessmentId)
    if (!a) throw new Error('assessment not found')
    const isInput = (INPUT_KEYS as string[]).includes(field)
    const previous = isInput ? String(a.inputs?.[field as InputKey] ?? '') : String(formData.get('previous') ?? '').trim()
    let evidence = addCorrectionTo(parseEvidence(a.evidence), { field, previous, corrected, by, note, recorded_by: session.email })
    if (isInput) {
      const inputs = parseInputs({ ...(a.inputs ?? {}), [field]: corrected })
      evidence = { ...evidence, missing: missingInputs(inputs) }
      const steps = await getSteps(db, assessmentId)
      const leaks = a.leaks?.length ? topLeaks(inputs, traceFacts(steps), 3, statusesFromEvidence(evidence)) : []
      await db.query('update assessments set inputs = $1, leaks = $2, evidence = $3, recommended_door = $4 where id = $5',
        [JSON.stringify(inputs), JSON.stringify(leaks), JSON.stringify(evidence), leaks.length ? recommendedDoor(leaks) : a.recommended_door, assessmentId])
    } else {
      await db.query('update assessments set evidence = $1 where id = $2', [JSON.stringify(evidence), assessmentId])
    }
  }, { ip })
  log.info('assessment.correction', { id: assessmentId, field })
  revalidatePath(back)
  redirect(`${back}?corrected=1#evidence`)
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

/**
 * Legacy entry point kept for older callers: marks the agency columns applied inside the window.
 * New code applies credits through lib/credit/ledger.ts#applyCredit against a ledger row and an engagement.
 */
export async function applyCredit(agencyId: string) {
  const session = await requireRole('staff')
  await withUser(session, db => db.query(
    'update agencies set assessment_credit_applied_at = now() where id = $1 and assessment_credit_cents > 0 and assessment_credit_applied_at is null and (assessment_credit_expires_at is null or assessment_credit_expires_at >= now())',
    [agencyId]))
  revalidatePath(`/staff/agencies/${agencyId}`)
}
