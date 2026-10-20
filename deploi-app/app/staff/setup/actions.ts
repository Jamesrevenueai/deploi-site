'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { putFile } from '@/lib/storage'
import { upsertSetting } from '@/lib/setup/settings'
import { resendTestSend } from '@/lib/setup/providers'
import { log } from '@/lib/log'

const MAX = 10 * 1024 * 1024

export async function uploadTemplate(formData: FormData) {
  const session = await requireRole('staff')
  const kind = String(formData.get('kind') ?? '')
  const file = formData.get('file')
  if ((kind !== 'baa_template' && kind !== 'sow_template') || !(file instanceof File) || file.size === 0) redirect('/staff/setup?error=file-required')
  if (file.size > MAX) redirect('/staff/setup?error=file-too-large')
  const ext = (file.name.split('.').pop() ?? 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf'
  const path = `templates/${kind}.${ext}`
  await putFile(path, Buffer.from(await file.arrayBuffer()), file.type || 'application/octet-stream')
  await withUser(session, db => upsertSetting(db, kind, { path, name: file.name, size: file.size, uploaded_at: new Date().toISOString() }, session.uid), { ip: await requestIp() })
  log.info('setup.template.uploaded', { kind, size: file.size })
  revalidatePath('/staff/setup')
  redirect('/staff/setup?saved=template')
}

export async function saveBookingUrl(formData: FormData) {
  const session = await requireRole('staff')
  const url = String(formData.get('url') ?? '').trim()
  if (url && !/^https:\/\//i.test(url)) redirect('/staff/setup?error=booking-url-must-be-https')
  await withUser(session, db => upsertSetting(db, 'booking_url', { url }, session.uid), { ip: await requestIp() })
  revalidatePath('/staff/setup')
  redirect('/staff/setup?saved=booking')
}

export async function sendTestEmail() {
  const session = await requireRole('staff')
  const r = await resendTestSend(session.email)
  const q = new URLSearchParams({ test: r.ok ? 'ok' : 'failed', mocked: r.mocked ? '1' : '0' })
  if (r.error) q.set('err', r.error.slice(0, 120))
  redirect(`/staff/setup?${q}`)
}
