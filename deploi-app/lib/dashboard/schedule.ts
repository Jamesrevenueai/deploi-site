import { localHour } from './time'

export const SEND_HOUR = 7

/** The morning report goes out once, at 07:00 agency-local time. Cron runs hourly. */
export function shouldSendNow(timezone: string, now: Date, alreadySentToday: boolean): boolean {
  if (alreadySentToday) return false
  let h = Number.NaN
  try { h = localHour(timezone, now) } catch { /* fall through */ }
  if (Number.isNaN(h)) h = localHour('America/New_York', now)
  return h === SEND_HOUR
}
