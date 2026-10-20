'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireSession, requestIp } from '../auth'
import { withUser } from '../db'
import { log } from '../log'

const TABLE: Record<string, string> = { aide: 'aides', applicant: 'applicants', client: 'clients' }

/**
 * Toggle SMS consent on a contact record. Runs as the signed-in user, so RLS
 * limits a client user to their own agency; the audit trigger logs the change.
 */
export async function setSmsConsent(formData: FormData) {
  const session = await requireSession()
  const kind = String(formData.get('kind') ?? '')
  const id = String(formData.get('id') ?? '')
  const consent = String(formData.get('consent') ?? '') === 'true'
  const back = String(formData.get('back') ?? '/app/home')
  const table = TABLE[kind]
  if (!table || !id) throw new Error('invalid contact')
  await withUser(session, db => db.query(
    `update ${table} set sms_consent = $2, sms_consent_at = case when $2 then now() else null end where id = $1`, [id, consent]), { ip: await requestIp() })
  log.info('consent.sms.set', { kind, id, consent })
  revalidatePath(back)
  redirect(back)
}
