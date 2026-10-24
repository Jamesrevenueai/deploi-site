/**
 * Credit state as shown on pipeline cards and the agency page. Pure; no override path exists.
 * Readers may pass a ledger row (assessment_credits) or the legacy agency columns; the ledger row wins when both are present.
 */
import { creditLedgerState, creditDaysLeft, remainingCents, type CreditRow } from './ledger'

export type CreditFields = {
  assessment_credit_cents: number | null
  credit_expires_at: string | Date | null
  assessment_credit_applied_at?: string | Date | null
  credit_expired?: boolean | null
}
export type CreditState = 'none' | 'unpaid' | 'available' | 'partially_applied' | 'applied' | 'expired' | 'refunded'
export type CreditInput = CreditFields | CreditRow | null | undefined

const isLedger = (c: CreditInput): c is CreditRow => !!c && typeof (c as CreditRow).credit_cents === 'number' && 'payment_status' in (c as CreditRow)

export function creditState(c: CreditInput, now = new Date()): CreditState {
  if (!c) return 'none'
  if (isLedger(c)) return c.credit_cents > 0 ? creditLedgerState(c, now) : 'none'
  if (!c.assessment_credit_cents) return 'none'
  if (c.assessment_credit_applied_at) return 'applied'
  if (c.credit_expired) return 'expired'
  if (c.credit_expires_at && now.getTime() >= new Date(c.credit_expires_at).getTime()) return 'expired'
  return 'available'
}

export function daysLeft(c: CreditInput, now = new Date()): number | null {
  if (!c) return null
  if (isLedger(c)) return creditDaysLeft(c, now)
  if (!c.credit_expires_at) return null
  return Math.ceil((new Date(c.credit_expires_at).getTime() - now.getTime()) / 86400e3)
}

const money = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US')

/** One-line label for a card, or null when there is no credit. */
export function creditLabel(c: CreditInput, now = new Date()): string | null {
  const s = creditState(c, now)
  if (s === 'none' || !c) return null
  const amt = money(isLedger(c) ? c.credit_cents : c.assessment_credit_cents!)
  const mock = isLedger(c) && c.payment_is_mock && c.payment_status === 'mock_paid'
  if (s === 'applied') return `Credit applied: ${amt}`
  if (s === 'partially_applied') return `Credit: ${money(remainingCents(c as CreditRow))} of ${amt} remaining`
  if (s === 'expired') return `Credit expired: ${amt}`
  if (s === 'refunded') return `Credit refunded: ${amt}`
  if (s === 'unpaid') return mock ? `Credit ${amt}: mock payment, simulated, not usable` : `Credit ${amt}: fee not yet paid`
  const d = daysLeft(c, now) ?? 0
  return `Credit: ${amt}, expires in ${d} day${d === 1 ? '' : 's'}`
}
