/**
 * The Indigo design tokens (2026-11-22): ONE tokens file used by both the app and the marketing site, with the
 * approved values, and text colours that pass WCAG AA (4.5:1) on the grounds they are used on.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { TOKENS } from '../../lib/design/tokens'

const repo = join(__dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(repo, p), 'utf8')
const lum = (hex: string) => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

describe('Indigo tokens shared by app and site', () => {
  it('there is one tokens file: the app and the site both import deploi-app/styles/tokens.css, and no second copy exists', () => {
    expect(read('deploi-app/app/globals.css')).toMatch(/@import ["']\.\.\/styles\/tokens\.css["']/)
    expect(read('src/styles.css')).toMatch(/@import ["']\.\.\/deploi-app\/styles\/tokens\.css["']/)
    expect(existsSync(join(repo, 'styles/tokens.css'))).toBe(false)
  })
  it('carries the approved values', () => {
    const t = read('deploi-app/styles/tokens.css')
    for (const [k, v] of Object.entries({ ground: '#FFFFFF', panel: '#F5F7FF', border: '#E0E7FF', divider: '#EEF2FF', 'ink-heading': '#1E1B4B', 'ink-body': '#3730A3', 'ink-label': '#4F46E5', 'ink-secondary': '#312E81', accent: '#4F46E5', 'accent-hover': '#4338CA', violet: '#7C6BFF', coral: '#E8734A', 'coral-text': '#9A3412', 'coral-tint': '#FFF1EB' }))
      expect(t, k).toMatch(new RegExp(`--dp-${k}: ${v};`))
    expect(t).toMatch(/'Plus Jakarta Sans'/)
    expect(t).toMatch(/'JetBrains Mono'/)
    expect(t).toMatch(/prefers-reduced-motion: reduce/)
    expect(t).toMatch(/--dp-focus: 2px solid #4F46E5;/)
  })
  it('the TypeScript mirror matches the CSS', () => {
    const t = read('deploi-app/styles/tokens.css')
    for (const [k, v] of Object.entries(TOKENS.color)) expect(t, k).toMatch(new RegExp(`--dp-${k.replace(/([A-Z]|[0-9])/g, m => `-${m.toLowerCase()}`)}: ${v};`))
  })
  it('every text colour passes 4.5:1 on white and on the tinted panel; coral text passes on its tint; violet is never a text colour', () => {
    const c = TOKENS.color
    for (const ink of [c.inkHeading, c.inkBody, c.inkLabel, c.inkSecondary, c.accentHover]) {
      expect(contrast(ink, c.ground), ink).toBeGreaterThanOrEqual(4.5)
      expect(contrast(ink, c.panel), ink).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast('#FFFFFF', c.accent)).toBeGreaterThanOrEqual(4.5) // white on the indigo button
    expect(contrast(c.coralText, c.coralTint)).toBeGreaterThanOrEqual(4.5)
    const css = read('deploi-app/styles/tokens.css')
    expect(css).not.toMatch(/--c-(ink|body|muted|accent):\s*var\(--dp-violet\)/)
  })
})
