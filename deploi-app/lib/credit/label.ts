/** Credit state as shown on pipeline cards and the agency page. Pure; no override path exists. */
export type CreditFields = {
  assessment_credit_cents: number | null
  credit_expires_at: string | Date | null
  assessment_credit_applied_at?: string | Date | null
  credit_expired?: boolean | null
}
export type CreditState = 'none' | 'available' | 'applied' | 'expired'

export function creditState(c: CreditFields, now = new Date()): CreditState {
  if (!c.assessment_credit_cents) return 'none'
  if (c.assessment_credit_applied_at) return 'applied'
  if (c.credit_expired) return 'expired'
  if (c.credit_expires_at && now.getTime() >= new Date(c.credit_expires_at).getTime()) return 'expired'
  return 'available'
}

export function daysLeft(c: CreditFields, now = new Date()): number | null {
  if (!c.credit_expires_at) return null
  return Math.ceil((new Date(c.credit_expires_at).getTime() - now.getTime()) / 86400e3)
}

const money = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US')

/** One-line label for a card, or null when there is no credit. */
export function creditLabel(c: CreditFields, now = new Date()): string | null {
  const s = creditState(c, now)
  if (s === 'none') return null
  const amt = money(c.assessment_credit_cents!)
  if (s === 'applied') return `Credit applied: ${amt}`
  if (s === 'expired') return `Credit expired: ${amt}`
  const d = daysLeft(c, now) ?? 0
  return `Credit: ${amt}, expires in ${d} day${d === 1 ? '' : 's'}`
}
