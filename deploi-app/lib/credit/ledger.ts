/**
 * Assessment credit ledger. One credit per paid assessment; applications per engagement.
 * Rules (all enforced here, inside the caller's transaction):
 *  - only a credit whose payment_status is 'paid' and not mock can be applied
 *  - never after expires_at, never more than the remainder, never twice for the same engagement
 *  - never toward a standalone service (Website Improvement)
 */
import type { Db } from '../db'
import { getService } from '../catalog/services'

export type CreditRow = {
  id: string; agency_id: string; assessment_id: string | null; original_fee_cents: number; payment_status: string; payment_is_mock: boolean
  paid_at: string | null; eligible_service_key: string | null; credit_cents: number; applied_cents: number; issued_at: string; expires_at: string | null; note: string | null
}
export type CreditState = 'unpaid' | 'available' | 'partially_applied' | 'applied' | 'expired' | 'refunded'

export function remainingCents(c: Pick<CreditRow, 'credit_cents' | 'applied_cents'>) { return Math.max(0, c.credit_cents - c.applied_cents) }

export function creditLedgerState(c: CreditRow, now = new Date()): CreditState {
  if (c.payment_status === 'refunded') return 'refunded'
  if (c.payment_status !== 'paid' || c.payment_is_mock) return 'unpaid'
  if (remainingCents(c) === 0) return 'applied'
  if (c.expires_at && now.getTime() >= new Date(c.expires_at).getTime()) return 'expired'
  return c.applied_cents > 0 ? 'partially_applied' : 'available'
}

export class CreditError extends Error { constructor(public code: 'not_found' | 'not_paid' | 'expired' | 'exhausted' | 'ineligible_service' | 'already_applied' | 'over_remaining' | 'invalid_amount', msg: string) { super(msg); this.name = 'CreditError' } }

export async function listCredits(db: Db, agencyId: string) {
  return db.query<CreditRow>('select * from assessment_credits where agency_id = $1 order by issued_at desc', [agencyId])
}

export async function issueCredit(db: Db, input: { agencyId: string; assessmentId: string | null; feeCents: number; creditCents?: number; termDays: number; eligibleServiceKey?: string | null; createdBy: string | null; note?: string | null; now?: Date }) {
  const now = input.now ?? new Date()
  const expires = new Date(now.getTime() + input.termDays * 86400e3)
  const r = await db.one<{ id: string }>(
    `insert into assessment_credits (agency_id, assessment_id, original_fee_cents, credit_cents, eligible_service_key, issued_at, expires_at, created_by, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [input.agencyId, input.assessmentId, input.feeCents, input.creditCents ?? input.feeCents, input.eligibleServiceKey ?? null, now.toISOString(), expires.toISOString(), input.createdBy, input.note ?? null])
  return r!.id
}

/** Record the real payment of the assessment fee. A mock checkout must call this with isMock=true and it will NOT make the credit usable. */
export async function recordCreditPayment(db: Db, creditId: string, opts: { isMock: boolean; now?: Date }) {
  const now = opts.now ?? new Date()
  await db.query(`update assessment_credits set payment_status = $2, payment_is_mock = $3, paid_at = $4 where id = $1`,
    [creditId, opts.isMock ? 'mock_paid' : 'paid', opts.isMock, now.toISOString()])
}

export async function applyCredit(db: Db, input: { creditId: string; engagementRef: string; serviceKey: string; amountCents: number; actorId: string | null; now?: Date }) {
  const now = input.now ?? new Date()
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new CreditError('invalid_amount', 'amount must be a positive whole number of cents')
  const svc = getService(input.serviceKey)
  if (!svc || svc.standalone) throw new CreditError('ineligible_service', 'credits apply only to a qualifying build, never a standalone service')
  const c = await db.one<CreditRow>('select * from assessment_credits where id = $1 for update', [input.creditId])
  if (!c) throw new CreditError('not_found', 'credit not found')
  if (c.eligible_service_key && c.eligible_service_key !== input.serviceKey) throw new CreditError('ineligible_service', `credit is limited to ${c.eligible_service_key}`)
  const state = creditLedgerState(c, now)
  if (state === 'unpaid' || state === 'refunded') throw new CreditError('not_paid', 'the assessment fee has not been confirmed as paid')
  if (state === 'expired') throw new CreditError('expired', 'credit expired')
  if (state === 'applied') throw new CreditError('exhausted', 'credit fully applied')
  const dup = await db.one('select 1 from assessment_credit_applications where credit_id = $1 and engagement_ref = $2 and reversed_at is null', [c.id, input.engagementRef])
  if (dup) throw new CreditError('already_applied', 'credit already applied to this engagement')
  const remaining = remainingCents(c)
  if (input.amountCents > remaining) throw new CreditError('over_remaining', `only ${remaining} cents remain`)
  const app = await db.one<{ id: string }>(
    `insert into assessment_credit_applications (credit_id, agency_id, engagement_ref, service_key, amount_cents, applied_by, applied_at) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [c.id, c.agency_id, input.engagementRef, input.serviceKey, input.amountCents, input.actorId, now.toISOString()])
  await db.query('update assessment_credits set applied_cents = applied_cents + $2 where id = $1', [c.id, input.amountCents])
  return { applicationId: app!.id, remainingCents: remaining - input.amountCents }
}

export async function reverseApplication(db: Db, applicationId: string, note: string) {
  const a = await db.one<{ id: string; credit_id: string; amount_cents: number }>('select id, credit_id, amount_cents from assessment_credit_applications where id = $1 and reversed_at is null for update', [applicationId])
  if (!a) throw new CreditError('not_found', 'application not found or already reversed')
  await db.query('update assessment_credit_applications set reversed_at = now(), reversal_note = $2 where id = $1', [a.id, note])
  await db.query('update assessment_credits set applied_cents = greatest(0, applied_cents - $2) where id = $1', [a.credit_id, a.amount_cents])
}
