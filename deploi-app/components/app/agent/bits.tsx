/** The agent dashboard's visual pieces: the shared primitives (components/app/ui) plus the few only it needs. */
import type { ReactNode } from 'react'
import type { ScopeLevel } from '@/lib/app/contract'
import { Card as UiCard } from '@/components/app/ui'
export { Button, StatusPill, ProofChip, EmptyState, Table } from '@/components/app/ui'

export const HEADING_FONT = 'var(--app-font-heading)'

/** A dashboard card: the shared Card as a <section> named by its heading, with an optional action beside it. */
export function Card({ children, title, titleId, action, className }: { children: ReactNode; title?: string; titleId?: string; action?: ReactNode; className?: string }) {
  return (
    <UiCard as="section" aria-labelledby={title ? titleId : undefined} className={className}>
      {title && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id={titleId} className="app-h2" style={{ fontSize: 18 }}>{title}</h2>
          {action}
        </div>
      )}
      {children}
    </UiCard>
  )
}

/** read = green, draft = blue, ask first = gray, acts = deep violet (#F1EAFE / #5B21B6, 8.4:1). */
export const SCOPE_STYLE: Record<ScopeLevel, { bg: string; text: string; label: string }> = {
  read: { bg: '#ECF7F1', text: '#17663F', label: 'read' },
  draft: { bg: '#E6EAFF', text: '#2333A8', label: 'draft' },
  ask: { bg: '#F2F2F6', text: '#5C5C70', label: 'ask first' },
  act: { bg: '#F1EAFE', text: '#5B21B6', label: 'acts' },
}

export function MicIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><line x1="12" y1="18" x2="12" y2="21" />
    </svg>
  )
}
export function SendIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 12l16-8-6 16-2-7-8-1z" />
    </svg>
  )
}

export function formatStat(value: number, unit?: 'minutes' | 'count'): string {
  if (unit !== 'minutes') return value.toLocaleString('en-US')
  if (value < 60) return `${value} min`
  const h = Math.floor(value / 60), m = value % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

export function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
