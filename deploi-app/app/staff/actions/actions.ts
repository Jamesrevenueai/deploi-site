'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireRole, requestIp } from '@/lib/auth'
import { admin, withUser } from '@/lib/db'
import { log } from '@/lib/log'
import '@/workers'
import { runWorker, approveAction as approveRow, executeAction, type ExecuteResult } from '@/lib/workers/runtime'
import { WORKER_NAMES, type WorkerName } from '@/lib/workers/types'
import { assertBaaSigned, isBaaError, baaErrorUrl } from '@/lib/baa/gate'
import { runApplicantImport } from '@/lib/imports/applicants'
import type { Session } from '@/lib/session'

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()

/**
 * Tenant/role check before any approve/execute: the row must be visible to the signed-in staff user
 * under RLS (staff may act on every agency; a client session never reaches these actions).
 */
async function visibleAction(session: Session, id: string, ip: string | null): Promise<{ id: string; agency_id: string; status: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  return withUser(session, db => db.one<{ id: string; agency_id: string; status: string }>('select id, agency_id, status from proposed_actions where id = $1', [id]), { ip })
}

function flag(r: ExecuteResult): Record<string, string> {
  if (r.deferred) return { deferred: '1' }
  if (r.ok && !r.noop) return r.simulated ? { approved: '1', simulated: '1' } : { approved: '1', accepted: '1' }
  if (r.noop) return { noop: '1' }
  if (r.status === 'expired') return { expired: '1' }
  return { failed: '1', reason: r.reason ?? '' }
}

/** Approve, then execute right away. Approval is recorded even when execution is held, deferred or fails. */
async function approveThenExecute(formData: FormData, overrides?: { subject: string | null; body: string }) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const id = str(formData, 'id')
  const row = await visibleAction(session, id, ip)
  if (!row) redirect('/staff/actions?error=not-found')
  const ret = formData.get('return') ? (JSON.parse(String(formData.get('return'))) as Record<string, string>) : {}
  const result = await admin(async db => {
    if (row.status === 'proposed') { const a = await approveRow(db, id, { actorId: session.uid, overrides }); if (!a) return null }
    return executeAction(db, id, { actorId: session.uid })
  }, { actorId: session.uid, ip })
  log.info('action.approve', { id, status: result?.status, ok: result?.ok })
  revalidatePath('/staff/actions')
  redirect(`/staff/actions?${new URLSearchParams({ ...ret, ...(result ? flag(result) : { failed: '1' }), id })}`)
}

export async function approveAction(formData: FormData) { await approveThenExecute(formData) }

export async function editAndApproveAction(formData: FormData) {
  const subject = str(formData, 'subject') || null
  const body = str(formData, 'body')
  if (!body) redirect('/staff/actions?error=empty-body')
  await approveThenExecute(formData, { subject, body })
}

/** Retry a failed / unknown action under a new attempt scope (idempotent: an attempted/delivered row is a no-op). */
export async function retryAction(formData: FormData) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const id = str(formData, 'id')
  const row = await visibleAction(session, id, ip)
  if (!row) redirect('/staff/actions?error=not-found')
  const result = await admin(db => executeAction(db, id, { actorId: session.uid }), { actorId: session.uid, ip })
  log.info('action.retry', { id, status: result.status, ok: result.ok, noop: result.noop })
  revalidatePath('/staff/actions')
  redirect(`/staff/actions?${new URLSearchParams({ status: row.status, ...flag(result), id })}`)
}

export async function skipAction(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  await withUser(session, db => db.query("update proposed_actions set status = 'skipped', decided_at = now(), decided_by = $2 where id = $1 and status in ('proposed','approved','queued')", [id, session.uid]), { ip: await requestIp() })
  revalidatePath('/staff/actions')
  redirect(`/staff/actions?skipped=${id}`)
}

export async function saveAutoSend(formData: FormData) {
  const session = await requireRole('staff')
  const agencyId = str(formData, 'agency_id')
  const toggles: Record<string, boolean> = {}
  for (const w of WORKER_NAMES) toggles[w] = formData.get(`auto_${w}`) === 'on'
  await withUser(session, db => db.query('update agencies set auto_send = $2 where id = $1', [agencyId, JSON.stringify(toggles)]), { ip: await requestIp() })
  log.info('autosend.saved', { agency_id: agencyId, on: Object.values(toggles).filter(Boolean).length })
  revalidatePath('/staff/actions/settings')
  redirect(`/staff/actions/settings?agency=${agencyId}&saved=1`)
}

export async function runWorkerNow(formData: FormData) {
  await requireRole('staff')
  const agencyId = str(formData, 'agency_id')
  const worker = str(formData, 'worker') as WorkerName | 'all'
  const send = formData.get('send') === 'on'
  const names = worker === 'all' ? WORKER_NAMES : [worker]
  const out: string[] = []
  for (const n of names) {
    if (!WORKER_NAMES.includes(n)) continue
    const s = await runWorker(n, agencyId, { dryRun: !send })
    out.push(`${n}: ${s.inserted} new of ${s.proposed} proposed${s.sent ? `, ${s.sent} sent` : ''}${s.deferred ? `, ${s.deferred} queued for the contact window` : ''}`)
  }
  revalidatePath('/staff/actions')
  redirect(`/staff/actions/run?agency=${agencyId}&result=${encodeURIComponent(out.join(' · '))}`)
}

export async function logReferral(formData: FormData) {
  const session = await requireRole('staff')
  const agencyId = str(formData, 'agency_id')
  const hours = Number(str(formData, 'hours_per_week')) || null
  let id: { id: string } | null = null
  try {
    id = await withUser(session, async db => {
      await assertBaaSigned(db, agencyId)
      return db.one<{ id: string }>(
    `insert into referrals (agency_id, source_name, source_org, source_channel, source_email, client_name, county, service, hours_per_week, received_at, status, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),'new',$10) returning id`,
    [agencyId, str(formData, 'source_name') || null, str(formData, 'source_org') || null, str(formData, 'source_channel') || 'manual', str(formData, 'source_email') || null,
     str(formData, 'client_name') || null, str(formData, 'county') || null, str(formData, 'service') || null, hours, str(formData, 'notes') || null])
    }, { ip: await requestIp() })
  } catch (e) {
    if (isBaaError(e)) redirect(baaErrorUrl(`/staff/actions/referrals/new?agency=${agencyId}`))
    throw e
  }
  log.info('referral.logged', { referral_id: id?.id, agency_id: agencyId })
  const s = await runWorker('referral_response', agencyId, { dryRun: true })
  redirect(`/staff/actions?worker=referral_response&ran=${s.inserted}`)
}

/** Applicant CSV through the shared import toolkit (lib/imports): validation, duplicates, provenance, row errors. */
export async function importApplicants(formData: FormData) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const agencyId = str(formData, 'agency_id')
  const file = formData.get('file')
  const text = file instanceof File && file.size > 0 ? await file.text() : str(formData, 'csv')
  const filename = file instanceof File && file.size > 0 ? file.name : 'pasted.csv'
  if (!text.trim()) redirect(`/staff/actions/applicants/import?agency=${agencyId}&error=file-required`)
  let importId: string
  try {
    importId = await withUser(session, async db => {
      await assertBaaSigned(db, agencyId)
      const r = await runApplicantImport(db, { agencyId, text, filename, createdBy: session.uid })
      return r.importId
    }, { ip })
  } catch (e) {
    if (isBaaError(e)) redirect(baaErrorUrl(`/staff/actions/applicants/import?agency=${agencyId}`))
    throw e
  }
  const s = await runWorker('applicant_screening', agencyId, { dryRun: true })
  redirect(`/staff/actions/applicants/import?agency=${agencyId}&import=${importId}&ran=${s.inserted}`)
}
