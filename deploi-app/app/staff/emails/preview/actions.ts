'use server'
import { redirect } from 'next/navigation'
import { requireRole } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { sendMorningReport } from '@/lib/dashboard/send'

export async function sendTestToMe(formData: FormData) {
  const session = await requireRole('staff')
  const agency = String(formData.get('agency') ?? '')
  if (!agency) redirect('/staff/emails/preview?sent=error')
  const r = await withUser(session, db => sendMorningReport(db, agency, new Date(), { to: [session.email], record: false }))
  const res = r.results[0]
  redirect(`/staff/emails/preview?agency=${agency}&sent=${res?.ok ? (res.mocked ? 'mock' : 'ok') : 'error'}`)
}
