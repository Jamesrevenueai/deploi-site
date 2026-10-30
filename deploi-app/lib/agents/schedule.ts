/** Recurring execution: when an agent should run next. Times are computed in the merchant's timezone. */
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import type { AgentPolicy } from './policy'

export function nextRunAt(schedule: AgentPolicy['schedule'], from: Date): Date | null {
  if (schedule.kind === 'manual') return null
  if (schedule.kind === 'interval') return new Date(from.getTime() + schedule.everyHours * 3600e3)
  let tz = schedule.timezone
  try { toZonedTime(from, tz) } catch { tz = 'UTC' }
  const local = toZonedTime(from, tz)
  const candidate = new Date(local.getFullYear(), local.getMonth(), local.getDate(), schedule.hour, schedule.minute, 0, 0)
  let at = fromZonedTime(candidate, tz)
  if (at.getTime() <= from.getTime()) {
    const tomorrow = new Date(local.getFullYear(), local.getMonth(), local.getDate() + 1, schedule.hour, schedule.minute, 0, 0)
    at = fromZonedTime(tomorrow, tz)
  }
  return at
}
