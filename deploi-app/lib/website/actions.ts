'use server'
/**
 * Staff server actions for the Website Improvement workflow. Every action runs as the signed-in
 * staff user (RLS), strips password-like segments from free text, and redirects with a flag the
 * page shows as a banner. Nothing here sends, charges or contacts anyone: "Record payment" records
 * that a payment happened elsewhere; "Record mock payment (simulated)" is visibly simulated.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireRole, requestIp } from '../auth'
import { withUser } from '../db'
import { log } from '../log'
import { stripSecretsFrom, isSecretKey } from './sanitize'
import { ACCESS_STATUSES, FEASIBILITY, LABOR_KINDS, MAX_PAGES, type AccessStatus, type Feasibility, type LaborKind } from './states'
import { refreshTargetDate } from './queries'
import { transitionEngagement, TransitionError } from './transition'

const str = (fd: FormData, k: string, max = 4000) => String(fd.get(k) ?? '').trim().slice(0, max)
const idOf = (fd: FormData) => { const id = str(fd, 'id', 40); if (!/^[0-9a-f-]{36}$/i.test(id)) redirect('/staff/website?error=invalid-id'); return id }
const back = (id: string, flag: string) => `/staff/website/${id}?${flag}`
const done = (id: string, flag = 'saved=1') => { revalidatePath(`/staff/website/${id}`); revalidatePath('/staff/website'); redirect(back(id, flag)) }
const isUrl = (v: string) => /^https?:\/\/\S+$/i.test(v)

/** Qualification + delivery fields. Password-like keys are refused; password-like text segments are removed. */
export async function saveEngagementDetails(formData: FormData) {
  const session = await requireRole('staff')
  const id = idOf(formData)
  for (const k of formData.keys()) if (isSecretKey(k)) redirect(back(id, 'error=secret-field-refused'))
  const pages = [1, 2, 3].map(i => str(formData, `page_${i}`, 300)).filter(Boolean).slice(0, MAX_PAGES)
  const access = str(formData, 'access_status', 40)
  if (!(ACCESS_STATUSES as readonly string[]).includes(access)) redirect(back(id, 'error=invalid-access-status'))
  const feas = str(formData, 'feasibility', 40) || 'unconfirmed'
  if (!(FEASIBILITY as readonly string[]).includes(feas)) redirect(back(id, 'error=invalid-feasibility'))
  const websiteUrl = str(formData, 'website_url', 500)
  const previewUrl = str(formData, 'preview_url', 500)
  if (websiteUrl && !isUrl(websiteUrl)) redirect(back(id, 'error=invalid-url'))
  if (previewUrl && !isUrl(previewUrl)) redirect(back(id, 'error=invalid-preview-url'))
  const { fields, removed } = stripSecretsFrom({
    goal: str(formData, 'goal'), requested_changes: str(formData, 'requested_changes'), known_issues: str(formData, 'known_issues'),
    access_arrangement: str(formData, 'access_arrangement', 1000), backup_plan: str(formData, 'backup_plan'), rollback_note: str(formData, 'rollback_note'),
    handoff_summary: str(formData, 'handoff_summary'), feasibility_note: str(formData, 'feasibility_note', 1000), revision_status: str(formData, 'revision_status', 300),
  })
  if (removed) log.warn('website.secret_segments_removed', { id, count: removed })
  const contentReceived = str(formData, 'content_received_at', 10)
  const feasibility: { status: Feasibility; note: string | null; confirmed_at?: string; confirmed_by?: string } = { status: feas as Feasibility, note: fields.feasibility_note || null }
  if (feas !== 'unconfirmed') { feasibility.confirmed_at = new Date().toISOString(); feasibility.confirmed_by = session.uid }
  await withUser(session, async db => {
    await db.query(
      `update website_engagements set website_url = nullif($2,''), platform = nullif($3,''), goal = $4, pages = $5::jsonb, requested_changes = $6, known_issues = $7,
         access_status = $8, access_arrangement = $9, approval_contact = nullif($10,''), feasibility = $11::jsonb, backup_plan = $12, rollback_note = $13,
         preview_url = nullif($14,''), handoff_summary = $15, revision_status = nullif($16,''), maintenance_requested = $17,
         content_received_at = case when $18 = '' then null else $18::date end
       where id = $1`,
      [id, websiteUrl, str(formData, 'platform', 120), fields.goal, JSON.stringify(pages), fields.requested_changes, fields.known_issues,
        access as AccessStatus, fields.access_arrangement, str(formData, 'approval_contact', 200), JSON.stringify(feasibility), fields.backup_plan, fields.rollback_note,
        previewUrl, fields.handoff_summary, fields.revision_status, formData.get('maintenance_requested') === 'on', contentReceived])
    await refreshTargetDate(db, id)
  }, { ip: await requestIp() })
  done(id, removed ? 'saved=1&removed=' + removed : 'saved=1')
}

/** Records a payment that happened elsewhere (mode=real) or a clearly simulated one (mode=mock). Never charges anyone. */
export async function recordPayment(formData: FormData) {
  const session = await requireRole('staff')
  const id = idOf(formData)
  const mode = str(formData, 'mode', 10)
  if (mode !== 'real' && mode !== 'mock') redirect(back(id, 'error=invalid-payment-mode'))
  const reference = str(formData, 'reference', 200)
  if (mode === 'real' && !reference) redirect(back(id, 'error=payment-reference-required'))
  await withUser(session, async db => {
    await db.query(
      `update website_engagements set payment_status = $2, payment_is_mock = $3, paid_at = now(),
         acceptance_evidence = coalesce(acceptance_evidence, '{}'::jsonb) || jsonb_build_object('payment_reference', $4::text, 'payment_mock', $3::boolean)
       where id = $1`,
      [id, mode === 'real' ? 'paid' : 'mock_paid', mode === 'mock', reference || (mode === 'mock' ? 'simulated' : '')])
    await refreshTargetDate(db, id)
  }, { ip: await requestIp() })
  log.info('website.payment_recorded', { id, mock: mode === 'mock' })
  done(id, mode === 'mock' ? 'payment=mock' : 'payment=real')
}

export async function recordAcceptance(formData: FormData) {
  const session = await requireRole('staff')
  const id = idOf(formData)
  const { fields, removed } = stripSecretsFrom({ accepted_by: str(formData, 'accepted_by', 200), method: str(formData, 'method', 100), reference: str(formData, 'reference', 500) })
  if (!fields.accepted_by || !fields.method) redirect(back(id, 'error=acceptance-incomplete'))
  if (removed) log.warn('website.secret_segments_removed', { id, count: removed })
  const evidence = { accepted_by: fields.accepted_by, method: fields.method, reference: fields.reference || null, at: new Date().toISOString(), recorded_by: session.uid }
  await withUser(session, db => db.query(
    `update website_engagements set acceptance_evidence = coalesce(acceptance_evidence, '{}'::jsonb) || $2::jsonb where id = $1`, [id, JSON.stringify(evidence)]), { ip: await requestIp() })
  done(id)
}

export async function addLabor(formData: FormData) {
  const session = await requireRole('staff')
  const id = idOf(formData)
  const hours = Number(str(formData, 'hours', 10))
  const kind = str(formData, 'kind', 30)
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) redirect(back(id, 'error=invalid-hours'))
  if (!(LABOR_KINDS as readonly string[]).includes(kind)) redirect(back(id, 'error=invalid-kind'))
  const { fields, removed } = stripSecretsFrom({ note: str(formData, 'note', 1000) })
  if (removed) log.warn('website.secret_segments_removed', { id, count: removed })
  await withUser(session, db => db.query(
    'insert into website_labor (website_engagement_id, hours, kind, note, logged_by) values ($1,$2,$3,$4,$5)',
    [id, Math.round(hours * 100) / 100, kind as LaborKind, fields.note || null, session.uid]), { ip: await requestIp() })
  done(id, 'labor=1')
}

export async function addApprovedChange(formData: FormData) {
  const session = await requireRole('staff')
  const id = idOf(formData)
  const { fields } = stripSecretsFrom({ change: str(formData, 'change', 500) })
  if (!fields.change) redirect(back(id, 'error=change-required'))
  await withUser(session, db => db.query(
    `update website_engagements set approved_changes = approved_changes || to_jsonb($2::text) where id = $1`, [id, fields.change]), { ip: await requestIp() })
  done(id)
}

export async function removeApprovedChange(formData: FormData) {
  const session = await requireRole('staff')
  const id = idOf(formData)
  const index = Number(str(formData, 'index', 5))
  if (!Number.isInteger(index) || index < 0) redirect(back(id, 'error=invalid-index'))
  await withUser(session, db => db.query(`update website_engagements set approved_changes = approved_changes - $2::int where id = $1`, [id, index]), { ip: await requestIp() })
  done(id)
}

/** Before/after references are links or text references; nothing is uploaded. */
export async function addBeforeAfter(formData: FormData) {
  const session = await requireRole('staff')
  const id = idOf(formData)
  const { fields } = stripSecretsFrom({ page: str(formData, 'page', 300), before_ref: str(formData, 'before_ref', 500), after_ref: str(formData, 'after_ref', 500), note: str(formData, 'note', 500) })
  if (!fields.page || !fields.before_ref || !fields.after_ref) redirect(back(id, 'error=before-after-incomplete'))
  const entry = { page: fields.page, before_ref: fields.before_ref, after_ref: fields.after_ref, note: fields.note || null }
  await withUser(session, db => db.query(`update website_engagements set before_after = before_after || $2::jsonb where id = $1`, [id, JSON.stringify([entry])]), { ip: await requestIp() })
  done(id)
}

/** Customer approval evidence: method + reference + who + when. Required before "Customer approved" and before any publication. */
export async function recordCustomerApproval(formData: FormData) {
  const session = await requireRole('staff')
  const id = idOf(formData)
  const { fields } = stripSecretsFrom({ method: str(formData, 'method', 100), reference: str(formData, 'reference', 500), approved_by: str(formData, 'approved_by', 200) })
  const at = str(formData, 'at', 30)
  if (!fields.method || !fields.approved_by || !fields.reference) redirect(back(id, 'error=approval-incomplete'))
  const when = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString()
  const evidence = { method: fields.method, reference: fields.reference, approved_by: fields.approved_by, at: when, recorded_by: session.uid }
  await withUser(session, db => db.query(`update website_engagements set customer_approval_evidence = $2::jsonb where id = $1`, [id, JSON.stringify(evidence)]), { ip: await requestIp() })
  done(id, 'approval=1')
}

export async function recordPublicationVerification(formData: FormData) {
  const session = await requireRole('staff')
  const id = idOf(formData)
  const urls = str(formData, 'checked_urls', 3000).split(/\r?\n|,/).map(s => s.trim()).filter(Boolean).slice(0, 20)
  const { fields } = stripSecretsFrom({ notes: str(formData, 'notes', 2000) })
  if (!urls.length) redirect(back(id, 'error=checked-urls-required'))
  const verification = { checked_urls: urls, by: session.uid, at: new Date().toISOString(), notes: fields.notes || null }
  await withUser(session, db => db.query(
    `update website_engagements set publication_verification = $2::jsonb, publication_verified_at = now() where id = $1`, [id, JSON.stringify(verification)]), { ip: await requestIp() })
  done(id, 'verified=1')
}

export async function transitionForm(formData: FormData) {
  const session = await requireRole('staff')
  const id = idOf(formData)
  const to = str(formData, 'to', 40)
  const { fields } = stripSecretsFrom({ note: str(formData, 'note', 1000) })
  let flag = 'moved=' + encodeURIComponent(to)
  try {
    await withUser(session, db => transitionEngagement(db, id, to, session.uid, fields.note || null), { ip: await requestIp() })
    log.info('website.transition', { id, to })
  } catch (e) {
    if (e instanceof TransitionError) flag = 'blocked=' + encodeURIComponent(e.message)
    else throw e
  }
  done(id, flag)
}
