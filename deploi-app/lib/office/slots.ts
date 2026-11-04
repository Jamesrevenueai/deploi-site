/**
 * Free meeting slots from free/busy data: business hours and working days in the customer's time zone
 * (DST-correct: every local wall-clock time is converted with the zone's rules for that date), a buffer
 * around every busy interval, a minimum notice and a horizon. Pure: no I/O.
 */
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import type { BusyInterval } from './types'

export type SlotRules = {
  timezone: string
  /** ISO weekdays: 1 = Monday ... 7 = Sunday */
  days: number[]
  dayStart: string
  dayEnd: string
  durationMin: number
  bufferMin: number
  minNoticeHours: number
  horizonDays: number
  /** candidate start times are this many minutes apart, from the start of business hours */
  stepMin?: number
}
export type Slot = { start: string; end: string; label: string }

export function slotLabel(startIso: string, tz: string): string {
  return `${formatInTimeZone(new Date(startIso), tz, 'EEEE d MMMM, HH:mm')} (${tz})`
}

/** Every free candidate slot, in time order. */
export function allFreeSlots(busy: BusyInterval[], r: SlotRules, now: Date): Slot[] {
  const dur = r.durationMin * 60e3, buf = r.bufferMin * 60e3, step = (r.stepMin ?? 30) * 60e3
  const earliest = now.getTime() + r.minNoticeHours * 3600e3
  const latest = now.getTime() + r.horizonDays * 864e5
  const blocks = busy.map(b => ({ s: new Date(b.start).getTime() - buf, e: new Date(b.end).getTime() + buf }))
  const out: Slot[] = []
  const today = formatInTimeZone(now, r.timezone, 'yyyy-MM-dd')
  const [y, m, d] = today.split('-').map(Number)
  for (let i = 0; i <= r.horizonDays + 1; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i))
    const iso = day.toISOString().slice(0, 10)
    const weekday = ((day.getUTCDay() + 6) % 7) + 1
    if (!r.days.includes(weekday)) continue
    const open = fromZonedTime(`${iso}T${r.dayStart}:00`, r.timezone).getTime()
    const close = fromZonedTime(`${iso}T${r.dayEnd}:00`, r.timezone).getTime()
    for (let t = open; t + dur <= close; t += step) {
      if (t < earliest || t + dur > latest) continue
      if (blocks.some(b => b.s < t + dur && b.e > t)) continue
      const start = new Date(t).toISOString()
      out.push({ start, end: new Date(t + dur).toISOString(), label: slotLabel(start, r.timezone) })
    }
  }
  return out
}

/** Up to `want` slots, spread over different days first (the earliest free slot of each day), then the rest in order. */
export function proposeSlots(busy: BusyInterval[], r: SlotRules, now: Date, want = 3): Slot[] {
  const all = allFreeSlots(busy, r, now)
  const byDay = new Map<string, Slot[]>()
  for (const s of all) {
    const k = formatInTimeZone(new Date(s.start), r.timezone, 'yyyy-MM-dd')
    byDay.set(k, [...(byDay.get(k) ?? []), s])
  }
  const picked: Slot[] = []
  for (let round = 0; picked.length < want && round < 48; round++) {
    let any = false
    for (const slots of byDay.values()) {
      if (picked.length >= want) break
      if (slots[round]) { picked.push(slots[round]); any = true }
    }
    if (!any) break
  }
  return picked.sort((a, b) => a.start.localeCompare(b.start))
}
