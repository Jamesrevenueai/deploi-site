/**
 * Contact windows in the agency's timezone. SMS never goes out outside capacity_rules.hours
 * (default 08:00–20:00 local); such an action is queued with send_after = next window start.
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { opsConfig } from './config'
import type { CapacityRules } from './types'

export type Window = { start: string; end: string }

export function contactWindow(rules: CapacityRules | null | undefined): Window {
  const h = rules?.hours
  if (h && /^\d{2}:\d{2}$/.test(h.start) && /^\d{2}:\d{2}$/.test(h.end) && h.start < h.end) return { start: h.start, end: h.end }
  return opsConfig.contactWindowDefault
}

export function inContactWindow(now: Date, tz: string, w: Window): boolean {
  const hm = formatInTimeZone(now, tz, 'HH:mm')
  return hm >= w.start && hm < w.end
}

/** Next instant at or after `now` when the window is open (now itself when already inside). */
export function nextWindowStart(now: Date, tz: string, w: Window): Date {
  if (inContactWindow(now, tz, w)) return now
  const today = formatInTimeZone(now, tz, 'yyyy-MM-dd')
  const todayStart = fromZonedTime(`${today}T${w.start}:00`, tz)
  if (todayStart > now) return todayStart
  const tomorrow = formatInTimeZone(new Date(now.getTime() + 86_400_000), tz, 'yyyy-MM-dd')
  return fromZonedTime(`${tomorrow}T${w.start}:00`, tz)
}

/** Agency-local calendar date, used as the period key for daily job locks. */
export function localDateKey(now: Date, tz: string): string {
  try { return formatInTimeZone(now, tz, 'yyyy-MM-dd') } catch { return formatInTimeZone(now, 'America/New_York', 'yyyy-MM-dd') }
}
