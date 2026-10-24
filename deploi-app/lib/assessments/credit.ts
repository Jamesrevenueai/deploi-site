/**
 * Assessment credit status for assessment and agency pages. The ledger (lib/credit/ledger.ts) is the truth;
 * the legacy agency columns are accepted so older callers keep compiling.
 */
import { creditLedgerState, type CreditRow } from '../credit/ledger'

export type CreditStatus = 'none' | 'unpaid' | 'available' | 'partially_applied' | 'applied' | 'expired' | 'refunded'

type Legacy = { assessment_credit_cents: number; assessment_credit_expires_at: string | Date | null; assessment_credit_applied_at?: string | Date | null }
const isLedger = (a: CreditRow | Legacy): a is CreditRow => typeof (a as CreditRow).credit_cents === 'number' && 'payment_status' in a

/** Ledger row: the ledger state. Legacy columns: applied / expired / available by the build_sold stage inside the window. */
export function creditStatus(a: CreditRow | Legacy | null | undefined, prospectStage: string | null, prospectUpdatedAt?: string | Date | null, now = new Date()): CreditStatus {
  if (!a) return 'none'
  if (isLedger(a)) return a.credit_cents > 0 ? creditLedgerState(a, now) : 'none'
  if (!a.assessment_credit_cents) return 'none'
  const exp = a.assessment_credit_expires_at ? new Date(a.assessment_credit_expires_at) : null
  if (a.assessment_credit_applied_at) return 'applied'
  const sold = prospectStage === 'build_sold' || prospectStage === 'retainer'
  if (sold && exp && prospectUpdatedAt && new Date(prospectUpdatedAt) <= exp) return 'applied'
  if (exp && now > exp) return 'expired'
  return 'available'
}
