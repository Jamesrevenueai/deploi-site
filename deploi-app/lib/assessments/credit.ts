export type CreditStatus = 'none' | 'available' | 'applied' | 'expired'

/** Assessment fee is credited toward a build if build_sold happens within 60 days. */
export function creditStatus(a: { assessment_credit_cents: number; assessment_credit_expires_at: string | Date | null; assessment_credit_applied_at?: string | Date | null }, prospectStage: string | null, prospectUpdatedAt?: string | Date | null, now = new Date()): CreditStatus {
  if (!a.assessment_credit_cents) return 'none'
  const exp = a.assessment_credit_expires_at ? new Date(a.assessment_credit_expires_at) : null
  if (a.assessment_credit_applied_at) return 'applied'
  const sold = prospectStage === 'build_sold' || prospectStage === 'retainer'
  if (sold && exp && prospectUpdatedAt && new Date(prospectUpdatedAt) <= exp) return 'applied'
  if (exp && now > exp) return 'expired'
  return 'available'
}
