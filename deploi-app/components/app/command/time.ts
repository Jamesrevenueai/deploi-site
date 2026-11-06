/** Small client-side wording helpers for the Command center (no data access). */

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function agoText(iso: string | null, now = new Date()): string | null {
  if (!iso) return null
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

const hourIn = (d: Date, timeZone: string) => {
  try { return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(d)) } catch { return d.getUTCHours() }
}

/** Morning until noon, afternoon until 6 pm, evening after (in the business's time zone). */
export function greeting(now: Date, timeZone = 'UTC'): string {
  const h = hourIn(now, timeZone)
  return h < 5 ? 'Good evening.' : h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.'
}

export function dateLine(now: Date, timeZone = 'UTC'): string {
  try { return now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone }) } catch { return now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }) }
}

/** 0 -> "0 min", 45 -> "45 min", 200 -> "3 h 20 min". */
export function minutesText(min: number): string {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60), r = m % 60
  return r ? `${h} h ${r} min` : `${h} h`
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
