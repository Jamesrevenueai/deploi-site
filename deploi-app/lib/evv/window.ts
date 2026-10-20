/** Correction-window clock. Ohio default 60 days; per-state table from env EVV_CORRECTION_WINDOWS. */
import { env } from '../env'

const DAY = 86_400_000

export function windowDays(state: string | null | undefined, table: Record<string, number> = env.evvWindows): number {
  const s = (state ?? 'OH').toUpperCase()
  return table[s] ?? table.OH ?? 60
}

export function windowCloses(visitDate: Date, state: string | null | undefined, table?: Record<string, number>): Date {
  return new Date(visitDate.getTime() + windowDays(state, table) * DAY)
}

export function daysLeft(closesAt: Date, now: Date = new Date()): number {
  return Math.ceil((closesAt.getTime() - now.getTime()) / DAY)
}

export type WindowTone = 'danger' | 'warn' | 'none'
export function windowTone(days: number): WindowTone {
  if (days <= 7) return 'danger'
  if (days <= 21) return 'warn'
  return 'none'
}

export function windowLabel(days: number): string {
  if (days < 0) return `closed ${-days}d ago`
  if (days === 0) return 'closes today'
  return `${days}d left`
}
