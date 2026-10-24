'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { log } from '@/lib/log'
import { createEngagement, updateProposal } from '@/lib/engagements/queries'
import { EngagementServiceError } from '@/lib/engagements/defaults'
import { transitionEngagement, TransitionError } from '@/lib/engagements/transition'
import { applyEngagementCredit, CreditError } from '@/lib/engagements/credit'
import type { ProposalFields } from '@/lib/engagements/types'
import { completeItem, uncompleteItem, DEFAULT_ITEMS } from '@/lib/onboarding/checklist'
import { testInputSource } from '@/lib/onboarding/input-test'
import { upsertPilot, getPilot, computePeriod, recordDecision, recordManualMeasurement, PilotError } from '@/lib/pilots/queries'

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const lines = (fd: FormData, k: string) => str(fd, k).split('\n').map(s => s.trim()).filter(Boolean)
const intOrNull = (fd: FormData, k: string) => { const v = str(fd, k); if (!v) return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null }
const dollarsToCents = (fd: FormData, k: string) => { const n = Number(str(fd, k)); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0 }
const uuid = (v: string) => (/^[0-9a-f-]{36}$/i.test(v) ? v : null)
const back = (id: string, q: Record<string, string>) => `/staff/engagements/${id}?${new URLSearchParams(q)}`

export async function createDraft(formData: FormData) {
  const session = await requireRole('staff')
  const agencyId = uuid(str(formData, 'agency_id'))
  const serviceKey = str(formData, 'service_key')
  const prospectId = uuid(str(formData, 'prospect_id'))
  const assessmentId = uuid(str(formData, 'assessment_id'))
  const q = new URLSearchParams({ ...(agencyId && { agency: agencyId }), ...(prospectId && { prospect: prospectId }), ...(assessmentId && { assessment: assessmentId }), service: serviceKey })
  if (!agencyId) redirect(`/staff/engagements/new?${q}&error=agency-required`)
  let id = ''
  let err: string | null = null
  try {
    id = await withUser(session, db => createEngagement(db, { agencyId, prospectId, assessmentId, serviceKey, createdBy: session.uid }), { ip: await requestIp() })
  } catch (e) {
    err = e instanceof EngagementServiceError ? e.code.replace(/_/g, '-') : 'could-not-create'
    log.warn('engagement.create_failed', { error: (e as Error).message })
  }
  if (err) redirect(`/staff/engagements/new?${q}&error=${err}`)
  log.info('engagement.created', { engagement_id: id, agency_id: agencyId, service_key: serviceKey })
  revalidatePath('/staff/engagements')
  redirect(`/staff/engagements/${id}?created=1`)
}

export async function saveProposal(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  const fields: Partial<ProposalFields> = {
    setup_fee_cents: dollarsToCents(formData, 'setup_fee_dollars'),
    monthly_fee_cents: dollarsToCents(formData, 'monthly_fee_dollars'),
    defined_workflow: str(formData, 'defined_workflow') || null,
    included_volume: intOrNull(formData, 'included_volume'),
    volume_units: str(formData, 'volume_units') || null,
    usage_terms: str(formData, 'usage_terms') || null,
    input_method: str(formData, 'input_method') || null,
    integration_key: str(formData, 'integration_key') || null,
    milestones: lines(formData, 'milestones').map(l => { const m = /^(.*?)(?:\s*@\s*(\d{4}-\d{2}-\d{2}))?\s*(\[x\])?$/i.exec(l); return { title: (m?.[1] ?? l).trim(), due_on: m?.[2] ?? null, done: Boolean(m?.[3]) } }),
    acceptance_criteria: lines(formData, 'acceptance_criteria'),
    agency_contact: str(formData, 'agency_contact') || null,
    deploi_owner: str(formData, 'deploi_owner') || null,
    approval_owner: str(formData, 'approval_owner') || null,
    support_hours: str(formData, 'support_hours') || null,
    support_timezone: str(formData, 'support_timezone') || null,
    escalation_contact: str(formData, 'escalation_contact') || null,
    fix_period_days: intOrNull(formData, 'fix_period_days'),
    initial_term_months: intOrNull(formData, 'initial_term_months'),
    exclusions: lines(formData, 'exclusions'),
    change_request_process: str(formData, 'change_request_process') || null,
  }
  const r = await withUser(session, db => updateProposal(db, id, fields), { ip: await requestIp() })
  revalidatePath(`/staff/engagements/${id}`)
  redirect(back(id, r.locked ? { saved: 'contacts' } : { saved: '1' }))
}

export async function moveStatus(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  const to = str(formData, 'to')
  const note = str(formData, 'note') || null
  const acceptance = to === 'accepted'
    ? { method: str(formData, 'method') as 'email', reference: str(formData, 'reference'), accepted_by: str(formData, 'accepted_by'), accepted_at: str(formData, 'accepted_at') ? new Date(str(formData, 'accepted_at')).toISOString() : '' }
    : null
  let q: Record<string, string>
  try {
    const r = await withUser(session, db => transitionEngagement(db, { engagementId: id, to, actorId: session.uid, note, acceptance }), { ip: await requestIp() })
    q = { moved: r.to }
  } catch (e) {
    if (e instanceof TransitionError) q = { error: e.code.replace(/_/g, '-'), ...(e.unmet.length && { unmet: e.unmet.join(' · ') }) }
    else throw e
  }
  revalidatePath(`/staff/engagements/${id}`)
  revalidatePath('/staff/engagements')
  redirect(back(id, q))
}

export async function applyCreditAction(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  const creditId = str(formData, 'credit_id')
  const amountCents = dollarsToCents(formData, 'amount_dollars')
  let q: Record<string, string>
  try {
    const r = await withUser(session, db => applyEngagementCredit(db, { engagementId: id, creditId, amountCents, actorId: session.uid }), { ip: await requestIp() })
    q = { credit: String(r.creditAppliedCents) }
  } catch (e) {
    if (e instanceof CreditError) q = { error: `credit-${e.code.replace(/_/g, '-')}` }
    else throw e
  }
  revalidatePath(`/staff/engagements/${id}`)
  redirect(back(id, q))
}

export async function toggleItem(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  const key = str(formData, 'key')
  const done = str(formData, 'done') === '1'
  if (!DEFAULT_ITEMS.some(d => d.key === key)) redirect(back(id, { error: 'unknown-item' }))
  await withUser(session, async db => {
    if (done) await completeItem(db, { engagementId: id, key, actorId: session.uid, note: str(formData, 'note') || null, evidence: { simulated: false, method: 'staff_confirmed' } })
    else await uncompleteItem(db, { engagementId: id, key })
  }, { ip: await requestIp() })
  revalidatePath(`/staff/engagements/${id}`)
  redirect(back(id, { item: key }))
}

export async function testInput(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  const inputMethod = str(formData, 'input_method') || null
  const r = await withUser(session, db => testInputSource(db, { engagementId: id, inputMethod, actorId: session.uid, actorEmail: session.email, smsTo: null }), { ip: await requestIp() })
  revalidatePath(`/staff/engagements/${id}`)
  redirect(back(id, { test: r.recorded ? (r.mocked ? 'mocked' : r.ok ? 'ok' : 'failed') : 'unsupported', ...(r.error && { detail: r.error.slice(0, 120) }) }))
}

export async function savePilot(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  const agencyId = str(formData, 'agency_id')
  const serviceKey = str(formData, 'service_key')
  let q: Record<string, string>
  try {
    await withUser(session, db => upsertPilot(db, {
      engagementId: id, agencyId, serviceKey,
      startsOn: str(formData, 'starts_on') || null, endsOn: str(formData, 'ends_on') || null, scope: str(formData, 'scope') || null, sampleDescription: str(formData, 'sample_description') || null,
      baselineStart: str(formData, 'baseline_start') || null, baselineEnd: str(formData, 'baseline_end') || null, primaryMetricKey: str(formData, 'primary_metric_key') || null,
      qualityGuardrails: lines(formData, 'quality_guardrails'), dataSources: lines(formData, 'data_sources'), reviewOwner: str(formData, 'review_owner') || null,
    }), { ip: await requestIp() })
    q = { pilot: 'saved' }
  } catch (e) {
    if (e instanceof PilotError) q = { error: `pilot-${e.code.replace(/_/g, '-')}` }
    else throw e
  }
  revalidatePath(`/staff/engagements/${id}`)
  redirect(back(id, q))
}

export async function computePilotPeriod(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  const period = str(formData, 'period') === 'baseline' ? 'baseline' : 'pilot'
  let q: Record<string, string>
  try {
    const n = await withUser(session, async db => {
      const p = await getPilot(db, id)
      if (!p) throw new PilotError('not_found', 'define the pilot first')
      return (await computePeriod(db, p, period, session.uid)).length
    }, { ip: await requestIp() })
    log.info('pilot.computed', { engagement_id: id, period, measures: n })
    q = { computed: period }
  } catch (e) {
    if (e instanceof PilotError) q = { error: `pilot-${e.code.replace(/_/g, '-')}` }
    else throw e
  }
  revalidatePath(`/staff/engagements/${id}`)
  redirect(back(id, q))
}

export async function saveManualMeasurement(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  const period = str(formData, 'period') === 'baseline' ? 'baseline' : 'pilot'
  const value = Number(str(formData, 'value'))
  if (!Number.isFinite(value) || value < 0) redirect(back(id, { error: 'measurement-invalid' }))
  let q: Record<string, string>
  try {
    await withUser(session, async db => {
      const p = await getPilot(db, id)
      if (!p) throw new PilotError('not_found', 'define the pilot first')
      await recordManualMeasurement(db, { pilot: p, metricKey: str(formData, 'metric_key'), period, value, sampleSize: intOrNull(formData, 'sample_size'), note: str(formData, 'note') || null, actorId: session.uid })
    }, { ip: await requestIp() })
    q = { computed: 'manual' }
  } catch (e) {
    if (e instanceof PilotError) q = { error: `pilot-${e.code.replace(/_/g, '-')}` }
    else throw e
  }
  revalidatePath(`/staff/engagements/${id}`)
  redirect(back(id, q))
}

export async function decidePilot(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  const decision = str(formData, 'decision')
  const note = str(formData, 'note') || null
  let q: Record<string, string>
  try {
    await withUser(session, async db => {
      const p = await getPilot(db, id)
      if (!p) throw new PilotError('not_found', 'define the pilot first')
      await recordDecision(db, { pilotId: p.id, decision, note, actorId: session.uid })
    }, { ip: await requestIp() })
    log.info('pilot.decided', { engagement_id: id, decision })
    q = { decided: decision }
  } catch (e) {
    if (e instanceof PilotError) q = { error: `pilot-${e.code.replace(/_/g, '-')}` }
    else throw e
  }
  revalidatePath(`/staff/engagements/${id}`)
  redirect(back(id, q))
}
