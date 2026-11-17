/**
 * Aurora v2 is the one theme for the app and the website: the tokens (styles/tokens.css, as on main @ 396a159)
 * and the semantic layer (styles/aurora.css) are shared verbatim, and no Aurora v1 value or light theme returns.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = join(__dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(repo, p), 'utf8')

describe('Aurora v2 tokens shared by app and site', () => {
  it('the app copies of tokens.css and aurora.css are identical to the shared ones', () => {
    for (const f of ['tokens.css', 'aurora.css']) expect(read(`deploi-app/styles/${f}`), f).toBe(read(`styles/${f}`))
  })
  it('the tokens are Aurora v2 (night ground #05060D, the dark -> blue -> pink -> orange glow), with no v1 value', () => {
    const t = read('styles/tokens.css')
    expect(t).toMatch(/--au-ground: #05060D;/)
    expect(t).toMatch(/--au-glow: radial-gradient/)
    expect(t).toMatch(/--au-text-glow: linear-gradient\(90deg, #3B6CFF 0%, #F0569E 55%, #FF8A3D 100%\)/)
    expect(t).not.toMatch(/--au-ground: #06080F/)
  })
  it('both the app and the site load the shared layer and neither declares a light page', () => {
    const app = read('deploi-app/app/globals.css'), site = read('src/styles.css')
    for (const css of [app, site]) {
      expect(css).toMatch(/@import ['"]\.\.\/styles\/tokens\.css['"]/)
      expect(css).toMatch(/@import ['"]\.\.\/styles\/aurora\.css['"]/)
      expect(css).not.toMatch(/color-scheme: light/)
    }
    expect(read('styles/aurora.css')).toMatch(/:root, \.aurora-ground, \.metal \{\n  color-scheme: dark;/)
  })

  it('a tile stays a white surface inside a card or panel (its value was white on white); the night sky fills short pages', () => {
    const css = read('styles/aurora.css')
    for (const sel of ['.panel .metal', '.card .metal', '.bg-surface .metal', '.aurora-ground .metal', '.aurora-surface .metal']) expect(css, sel).toContain(`${sel}:not(.tile)`)
    expect(css).toMatch(/^body \{ min-height: 100vh; min-height: 100dvh;/m)
  })
})
