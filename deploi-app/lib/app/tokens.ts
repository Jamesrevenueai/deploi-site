/** Design tokens for the logged-in app (Indigo theme, 2026-11-22). Mirrors styles/app-tokens.css; the base palette is lib/design/tokens.ts. */
export const tokens = {
  font: { body: 'Plus Jakarta Sans', heading: 'Plus Jakarta Sans', mono: 'JetBrains Mono' },
  backdrop: { base: '#FFFFFF', glowTopLeft: '#FFFFFF', glowTopRight: '#FFFFFF', glowBottomRight: '#FFFFFF' },
  surface: { bg: '#FFFFFF', maxWidth: 1392, radius: 20, shadow: 'none', padX: 28, padY: 24 },
  text: { primary: '#1E1B4B', secondary: '#312E81', body: '#3730A3' },
  border: { card: '#E0E7FF', input: '#E0E7FF', divider: '#EEF2FF' },
  fill: { subtle: '#F5F7FF' },
  button: { primaryBg: '#4F46E5', primaryText: '#FFFFFF', radius: 12, minHeight: 44 },
  card: { radius: 16, radiusLg: 20 },
  status: {
    working: { bg: '#EEF2FF', text: '#4338CA', label: 'Working' },
    waiting: { bg: '#FFF1EB', text: '#9A3412', label: 'Needs you' },
    watching: { bg: '#ECFDF5', text: '#047857', label: 'Watching' },
    off: { bg: '#EEF2FF', text: '#312E81', label: 'Idle' },
  },
  proofChip: { bg: '#EEF2FF', text: '#4338CA' },
  usageBar: '#4F46E5',
  hero: { bg: '#F5F7FF', radius: 24, live: '#047857', waitingStat: '#9A3412' },
} as const
