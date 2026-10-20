'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { putFile } from '@/lib/storage'
import { log } from '@/lib/log'

const MAX_BYTES = 10 * 1024 * 1024

/** Stores the signed BAA PDF and stamps the agency. Opens every gated ingest path. */
export async function markBaaSigned(formData: FormData) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const assessmentId = String(formData.get('assessment_id') ?? '')
  const agencyId = String(formData.get('agency_id') ?? '')
  const signedOn = String(formData.get('signed_on') ?? '').slice(0, 10)
  const file = formData.get('file')
  const back = `/staff/assessments/${assessmentId}`
  if (!/^[0-9a-f-]{36}$/i.test(agencyId) || !/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) redirect(`${back}?error=baa-invalid`)
  if (!(file instanceof File) || file.size === 0) redirect(`${back}?error=baa-file-required`)
  if (file.size > MAX_BYTES) redirect(`${back}?error=baa-file-too-large`)
  const bytes = Buffer.from(await file.arrayBuffer())
  if (file.type !== 'application/pdf' || bytes.subarray(0, 4).toString() !== '%PDF') redirect(`${back}?error=baa-not-pdf`)
  const path = `${agencyId}/baa-${signedOn}.pdf`
  await putFile(path, bytes, 'application/pdf')
  await withUser(session, db => db.query('update agencies set baa_signed_at = $2::date, baa_document_url = $3 where id = $1', [agencyId, signedOn, path]), { ip })
  log.info('baa.signed', { agency_id: agencyId, bytes: bytes.length })
  revalidatePath(back)
  revalidatePath(`/staff/agencies/${agencyId}`)
  redirect(`${back}?baa=signed`)
}
