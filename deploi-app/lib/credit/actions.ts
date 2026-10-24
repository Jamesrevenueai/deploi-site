'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireRole, requestIp } from '../auth'
import { withUser } from '../db'
import { log } from '../log'
import { recordCreditPayment, CreditError } from './ledger'

const safeBack = (v: string) => (/^\/staff\/[a-z0-9/_-]*$/i.test(v) ? v : '/staff/assessments')

/**
 * Staff records the assessment-fee payment on the ledger row. `mock=1` records a simulated payment that never makes the
 * credit usable (shown everywhere with a "simulated" badge). No money moves here in either case: a real payment is an
 * attestation that the fee was received outside this application.
 */
export async function recordPaymentAction(formData: FormData) {
  const session = await requireRole('staff')
  const ip = await requestIp()
  const creditId = String(formData.get('credit_id') ?? '')
  const isMock = String(formData.get('mock') ?? '') === '1'
  const note = String(formData.get('note') ?? '').trim() || null
  const back = safeBack(String(formData.get('back') ?? ''))
  if (!/^[0-9a-f-]{36}$/i.test(creditId)) redirect(`${back}?error=credit-not-found#credit`)
  try {
    await withUser(session, db => recordCreditPayment(db, creditId, { isMock, recordedBy: session.uid, note }), { ip })
  } catch (e) {
    const code = e instanceof CreditError ? e.code : 'failed'
    redirect(`${back}?error=credit-${code}#credit`)
  }
  log.info('credit.payment.recorded', { credit_id: creditId, mock: isMock })
  revalidatePath(back)
  revalidatePath('/staff/pipeline')
  redirect(`${back}?credit=${isMock ? 'mock_paid' : 'paid'}#credit`)
}
