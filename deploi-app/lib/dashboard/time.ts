import { fromZonedTime, toZonedTime, formatInTimeZone } from 'date-fns-tz'
import { addDays } from 'date-fns'

/** Start of the agency's local day (as a UTC instant). */
export function localDayStart(tz: string, now: Date): Date {
  return fromZonedTime(formatInTimeZone(now, tz, 'yyyy-MM-dd') + 'T00:00:00', tz)
}
export function localDate(tz: string, now: Date): string {
  return formatInTimeZone(now, tz, 'yyyy-MM-dd')
}
export function localHour(tz: string, now: Date): number {
  return toZonedTime(now, tz).getHours()
}
export function daysFromNow(tz: string, now: Date, days: number): string {
  return formatInTimeZone(addDays(now, days), tz, 'yyyy-MM-dd')
}
export function daysUntil(date: string | Date | null, now: Date): number | null {
  if (!date) return null
  const d = typeof date === 'string' ? new Date(date) : date
  return Math.ceil((d.getTime() - now.getTime()) / 86400e3)
}
export function initials(first: string | null | undefined, last: string | null | undefined): string {
  const f = (first ?? '').trim()[0] ?? ''
  const l = (last ?? '').trim()[0] ?? ''
  return `${f ? f.toUpperCase() + '.' : ''}${l ? l.toUpperCase() + '.' : ''}` || '—'
}
