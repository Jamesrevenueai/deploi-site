/**
 * SMS consent lookup for the recipient descriptors the worker runtime uses:
 * 'aide:<id>', 'applicant:<id>', 'family:<client_id>'. Anything else is not textable here.
 */
import type { Db } from '../db'

export const NO_SMS_CONSENT = 'no SMS consent'

const TABLE: Record<string, string> = { aide: 'aides', applicant: 'applicants', family: 'clients' }

export async function hasSmsConsent(db: Db, agencyId: string, toRef: string | null): Promise<boolean> {
  if (!toRef) return false
  const [type, id] = toRef.split(':')
  const table = TABLE[type]
  if (!table || !id) return false
  const r = await db.one<{ sms_consent: boolean }>(`select sms_consent from ${table} where id = $1 and agency_id = $2`, [id, agencyId])
  return r?.sms_consent === true
}
