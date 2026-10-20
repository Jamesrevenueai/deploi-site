'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireRole, requestIp } from '@/lib/auth'
import { admin, withUser } from '@/lib/db'
import { log } from '@/lib/log'
import '@/workers'
import { runWorker, sendProposedAction } from '@/lib/workers/runtime'
import { WORKER_NAMES, type WorkerName } from '@/lib/workers/types'

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()

export async function approveAction(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  const ok = await admin(db => sendProposedAction(db, id, { actorId: session.uid }), { actorId: session.uid, ip: await requestIp() })
  log.info('action.approve', { id, ok })
  revalidatePath('/staff/actions')
  redirect(`/staff/actions?${new URLSearchParams({ ...(formData.get('return') ? JSON.parse(String(formData.get('return'))) : {}), ...(ok ? { approved: id } : { failed: id }) })}`)
}

export async function editAndApproveAction(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  const subject = str(formData, 'subject') || null
  const body = str(formData, 'body')
  if (!body) redirect('/staff/actions?error=empty-body')
  const ok = await admin(db => sendProposedAction(db, id, { actorId: session.uid, overrides: { subject, body } }), { actorId: session.uid, ip: await requestIp() })
  log.info('action.edit-approve', { id, ok })
  revalidatePath('/staff/actions')
  redirect(`/staff/actions?${ok ? 'approved' : 'failed'}=${id}`)
}

export async function skipAction(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  await withUser(session, db => db.query("update proposed_actions set status = 'skipped', decided_at = now(), decided_by = $2 where id = $1 and status = 'proposed'", [id, session.uid]), { ip: await requestIp() })
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
    out.push(`${n}: ${s.inserted} new of ${s.proposed} proposed${s.sent ? `, ${s.sent} sent` : ''}`)
  }
  revalidatePath('/staff/actions')
  redirect(`/staff/actions/run?agency=${agencyId}&result=${encodeURIComponent(out.join(' · '))}`)
}

export async function logReferral(formData: FormData) {
  const session = await requireRole('staff')
  const agencyId = str(formData, 'agency_id')
  const hours = Number(str(formData, 'hours_per_week')) || null
  const id = await withUser(session, db => db.one<{ id: string }>(
    `insert into referrals (agency_id, source_name, source_org, source_channel, source_email, client_name, county, service, hours_per_week, received_at, status, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),'new',$10) returning id`,
    [agencyId, str(formData, 'source_name') || null, str(formData, 'source_org') || null, str(formData, 'source_channel') || 'manual', str(formData, 'source_email') || null,
     str(formData, 'client_name') || null, str(formData, 'county') || null, str(formData, 'service') || null, hours, str(formData, 'notes') || null]), { ip: await requestIp() })
  log.info('referral.logged', { referral_id: id?.id, agency_id: agencyId })
  const s = await runWorker('referral_response', agencyId, { dryRun: true })
  redirect(`/staff/actions?worker=referral_response&ran=${s.inserted}`)
}

export async function importApplicants(formData: FormData) {
  const session = await requireRole('staff')
  const agencyId = str(formData, 'agency_id')
  const file = formData.get('file')
  const text = file instanceof File ? await file.text() : str(formData, 'csv')
  const Papa = (await import('papaparse')).default
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true })
  let imported = 0, skipped = 0
  await withUser(session, async db => {
    for (const row of parsed.data) {
      const first = (row.first_name ?? row.First ?? row.first ?? '').trim()
      const last = (row.last_name ?? row.Last ?? row.last ?? '').trim()
      const phone = (row.phone ?? row.Phone ?? '').trim() || null
      const email = (row.email ?? row.Email ?? '').trim() || null
      if (!first || !last) { skipped++; continue }
      const dup = phone ? await db.one('select id from applicants where agency_id = $1 and phone = $2', [agencyId, phone]) : null
      if (dup) { skipped++; continue }
      await db.query("insert into applicants (agency_id, first_name, last_name, phone, email, source, status) values ($1,$2,$3,$4,$5,'csv','new')", [agencyId, first, last, phone, email])
      imported++
    }
  }, { ip: await requestIp() })
  log.info('applicants.imported', { agency_id: agencyId, imported, skipped })
  const s = await runWorker('applicant_screening', agencyId, { dryRun: true })
  redirect(`/staff/actions?worker=applicant_screening&imported=${imported}&skipped=${skipped}&ran=${s.inserted}`)
}
