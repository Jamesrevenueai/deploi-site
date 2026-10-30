import type { PermissionLevel, TierKey } from './types'

export const LEVEL_LABEL: Record<PermissionLevel, string> = { read: 'Read only', draft: 'Draft for approval', act: 'Act within limits' }
export const LEVEL_SHORT: Record<PermissionLevel, string> = { read: 'Read', draft: 'Draft', act: 'Act' }
export const TIER_NAME: Record<TierKey, string> = { starter: 'Starter', growth: 'Growth', pro: 'Pro' }
export const STATUS_WORDS: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' | 'none' }> = {
  draft: { label: 'Waiting for you', tone: 'none' }, approved: { label: 'Approved', tone: 'ok' }, declined: { label: 'Declined', tone: 'muted' }, done: { label: 'Done · verified', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' }, noted: { label: 'Reported', tone: 'muted' }, expired: { label: 'Expired', tone: 'muted' },
}
export const MODE_WORDS: Record<string, string> = { read: 'read', draft: 'draft', auto: 'auto-run' }
export function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)
}
export function fmtAgo(iso: string | null): string {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return fmtWhen(iso)
}
export const minutesWords = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`)
export const usd = (n: number) => `$${n.toFixed(n % 1 ? 2 : 0)}`
