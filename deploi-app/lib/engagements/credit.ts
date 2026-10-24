/**
 * Apply an assessment credit to an engagement through the ledger (lib/credit/ledger.ts owns the rules).
 * credit_applied_cents on the engagement mirrors the ledger; it is never set by hand.
 */
import type { Db } from '../db'
import { applyCredit, CreditError } from '../credit/ledger'
import { syncCreditApplied } from './queries'
import type { EngagementRow } from './types'

export { CreditError }

export async function applyEngagementCredit(db: Db, input: { engagementId: string; creditId: string; amountCents: number; actorId: string | null }) {
  const e = await db.one<Pick<EngagementRow, 'id' | 'service_key' | 'status' | 'agency_id'>>('select id, service_key, status, agency_id from engagements where id = $1 for update', [input.engagementId])
  if (!e) throw new CreditError('not_found', 'engagement not found')
  if (e.status === 'completed') throw new CreditError('invalid_amount', 'the engagement is completed')
  const credit = await db.one<{ agency_id: string }>('select agency_id from assessment_credits where id = $1', [input.creditId])
  if (!credit) throw new CreditError('not_found', 'credit not found')
  if (credit.agency_id !== e.agency_id) throw new CreditError('ineligible_service', 'the credit belongs to another agency')
  const r = await applyCredit(db, { creditId: input.creditId, engagementRef: e.id, serviceKey: e.service_key, amountCents: input.amountCents, actorId: input.actorId })
  const applied = await syncCreditApplied(db, e.id)
  return { ...r, creditAppliedCents: applied }
}

export const CREDIT_ERROR_TEXT: Record<CreditError['code'], string> = {
  not_found: 'That credit (or engagement) no longer exists.',
  not_paid: 'The assessment fee has not been confirmed as paid; a mock checkout never makes a credit usable.',
  expired: 'The credit expired before this engagement was sold. There is no override.',
  exhausted: 'The credit is fully applied.',
  ineligible_service: 'The credit cannot be applied to this service.',
  already_applied: 'This credit was already applied to this engagement.',
  over_remaining: 'The amount is more than what remains on the credit.',
  invalid_amount: 'Enter a positive whole-dollar amount on an open engagement.',
}
