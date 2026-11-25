/**
 * Shared pieces of the approved Indigo design (design-ref/app-*.html), ported verbatim: the node-graph logo, nav icons,
 * bot avatars, ring gauge, sparkline and status pill. Every value here is from the design files.
 */
import type { ReactNode } from 'react'
import { css } from './css'

export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" fill="#EEF2FF" />
      <path d="M10 10 L22 11 L21 22 L11 21 Z M10 10 L21 22" stroke="#A5B4FC" strokeWidth="1.5" fill="none" />
      <circle cx="10" cy="10" r="3.6" fill="#4F46E5" /><circle cx="22" cy="11" r="2.6" fill="#4F46E5" />
      <circle cx="11" cy="21" r="2.6" fill="#4F46E5" /><circle cx="21" cy="22" r="2.8" fill="#E8734A" />
    </svg>
  )
}
export function Wordmark({ size = 20 }: { size?: number }) {
  return <span style={css(`font-size: ${size}px; font-weight: 800; letter-spacing: -0.02em; color: #1E1B4B;`)}>deploi<span style={css('color: #4F46E5;')}>.ai</span></span>
}

const I = (p: { children: ReactNode; round?: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap={p.round ? 'round' : undefined} aria-hidden="true" focusable="false">{p.children}</svg>
)
export const NAV_ICONS = {
  command: <I><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></I>,
  agents: <I round><rect x="4" y="7" width="16" height="12" rx="4" /><path d="M12 3v4M9 13h.01M15 13h.01" /></I>,
  library: <I><path d="M4 5h5v14H4zM10 5h4v14h-4zM15.5 5.5l4-1 3 13.5-4 1z" /></I>,
  approvals: <I round><path d="M4 12l5 5L20 6" /></I>,
  proof: <I><path d="M6 3h9l4 4v14H6z" /><path d="M9 12h7M9 16h5" /></I>,
  connections: <I round><path d="M9 7H7a5 5 0 000 10h2M15 7h2a5 5 0 010 10h-2M8 12h8" /></I>,
  reports: <I round><path d="M4 19V9M10 19V5M16 19v-7M22 19H2" /></I>,
  settings: <I round><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" /></I>,
} as const

/** The 40px roster / library bot (design: app-command-center roster, app-agent-library cards). */
export function BotMark({ size = 40, bg = '#EEF2FF', body = '#4F46E5' }: { size?: number; bg?: string; body?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false" style={css('flex: none;')}>
      <rect width="40" height="40" rx="12" fill={bg} /><rect x="9" y="13" width="22" height="16" rx="6" fill={body} />
      <circle cx="16" cy="21" r="2.4" fill="#FFFFFF" /><circle cx="24" cy="21" r="2.4" fill="#FFFFFF" />
      <path d="M20 13V8" stroke={body} strokeWidth="2" /><circle cx="20" cy="7" r="2" fill="#E8734A" />
    </svg>
  )
}

/** The 96px agent hero bot (design: app-agent-dashboard). */
export function BotHero({ label }: { label: string }) {
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" role="img" aria-label={label} style={css('flex: none;')}>
      <rect width="96" height="96" rx="26" fill="#FFFFFF" stroke="#E0E7FF" /><path d="M48 26V16" stroke="#4F46E5" strokeWidth="3" strokeLinecap="round" />
      <circle cx="48" cy="14" r="5" fill="#E8734A" /><rect x="20" y="26" width="56" height="42" rx="16" fill="#4F46E5" />
      <rect x="28" y="36" width="40" height="20" rx="10" fill="#EEF2FF" /><circle cx="39" cy="46" r="4" fill="#1E1B4B" />
      <circle cx="57" cy="46" r="4" fill="#1E1B4B" /><rect x="34" y="72" width="28" height="10" rx="5" fill="#C7D2FE" />
    </svg>
  )
}

/** Ring gauge (r = 26, circumference 163). `value` 0..100; null draws an empty ring. */
export function Ring({ value, color = '#4F46E5', label }: { value: number | null; color?: string; label: string }) {
  const dash = value === null ? 0 : Math.round((Math.max(0, Math.min(100, value)) / 100) * 163)
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" role="img" aria-label={label}>
      <circle cx="32" cy="32" r="26" stroke="#E0E7FF" strokeWidth="8" fill="none" />
      {dash > 0 && <circle cx="32" cy="32" r="26" stroke={color} strokeWidth="8" fill="none" strokeLinecap="round" strokeDasharray={`${dash} 163`} transform="rotate(-90 32 32)" />}
    </svg>
  )
}

/** 72 x 24 sparkline from a series (oldest first). Flat when every value is equal. */
export function Sparkline({ series }: { series: number[] }) {
  const pts = series.length ? series : [0]
  const max = Math.max(...pts), min = Math.min(...pts)
  const step = pts.length > 1 ? 72 / (pts.length - 1) : 0
  const y = (v: number) => (max === min ? 12 : 20 - ((v - min) / (max - min)) * 16)
  const points = pts.map((v, i) => `${Math.round(i * step)},${Math.round(y(v) * 10) / 10}`).join(' ')
  return <svg width="72" height="24" viewBox="0 0 72 24" aria-hidden="true" focusable="false"><polyline points={points} fill="none" stroke="#6366F1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

export type PillKind = 'Working' | 'Needs you' | 'Idle' | 'Paused'
export const PILL: Record<PillKind, string> = {
  Working: 'font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;background:#4F46E5;color:#FFFFFF;white-space:nowrap;',
  'Needs you': 'font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;background:#FFF1EB;color:#9A3412;white-space:nowrap;',
  Idle: 'font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;background:#EEF2FF;color:#3730A3;white-space:nowrap;',
  Paused: 'font-size:12px;font-weight:700;padding:5px 10px;border-radius:999px;background:#EEF2FF;color:#3730A3;white-space:nowrap;',
}
export const Pill = ({ kind }: { kind: PillKind }) => <span style={css(PILL[kind])}>{kind}</span>

/** Visually hidden text (design `.sr`). */
export const Sr = ({ children }: { children: ReactNode }) => <span className="sr-only">{children}</span>

export const BTN_PRIMARY = 'min-height: 44px; padding: 0 18px; border: 0; border-radius: 12px; background: #4F46E5; color: #FFFFFF; font: inherit; font-weight: 700; font-size: 14px; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; text-decoration: none;'
export const BTN_SECONDARY = 'min-height: 44px; padding: 0 18px; border-radius: 12px; border: 1px solid #C7D2FE; background: #FFFFFF; color: #3730A3; font: inherit; font-size: 14px; font-weight: 700; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; text-decoration: none;'
export const CARD = 'border: 1px solid #E0E7FF; border-radius: 18px;'
export const H2 = 'margin: 0; font-size: 17px; font-weight: 800; color: #1E1B4B;'
