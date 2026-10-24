/**
 * Expiry for time-sensitive actions. Shift offers expire at shift start, a drafted first reply to a
 * referral after ACTION_REFERRAL_REPLY_EXPIRY_HOURS (72), everything else after ACTION_EXPIRY_HOURS_DEFAULT (0 = never).
 */
import { opsConfig } from './config'
import type { Proposal } from './types'

const H = 3_600_000

export function expiresAtFor(p: Pick<Proposal, 'payload' | 'expires_at' | 'kind'>, now: Date): Date | null {
  if (p.expires_at !== undefined) return p.expires_at
  const effect = p.payload?.effect as string | undefined
  if (effect === 'shift_offer_sent' && typeof p.payload?.shift_starts_at === 'string') {
    const d = new Date(p.payload.shift_starts_at); if (!isNaN(d.getTime())) return d
  }
  if (effect === 'referral_replied') return new Date(now.getTime() + opsConfig.referralReplyExpiryHours * H)
  if (p.kind === 'task') return null
  const h = opsConfig.defaultExpiryHours
  return h > 0 ? new Date(now.getTime() + h * H) : null
}

export const isExpired = (expiresAt: Date | string | null | undefined, now: Date) =>
  Boolean(expiresAt) && new Date(expiresAt as string).getTime() <= now.getTime()
