import type { CSSProperties } from 'react'

const cache = new Map<string, CSSProperties>()

/**
 * Turns a CSS declaration string ("display: flex; gap: 12px") into a React style object, so the approved design's
 * inline styles (design-ref/site-home.html) can be pasted verbatim. Results are memoized per string.
 */
export function css(decl: string): CSSProperties {
  let style = cache.get(decl)
  if (style) return style
  const out: Record<string, string> = {}
  for (const part of decl.split(';')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    const prop = part.slice(0, i).trim()
    const value = part.slice(i + 1).trim()
    if (!prop || !value) continue
    const key = prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    out[key] = value
  }
  style = out as CSSProperties
  cache.set(decl, style)
  return style
}
