import type { CSSProperties } from 'react'

/**
 * Port an approved design's inline style string (design-ref/*.html) verbatim: css('display: flex; gap: 12px') becomes a
 * React style object. Memoized per string. Works in server and client components.
 */
const cache = new Map<string, CSSProperties>()
export function css(s: string): CSSProperties {
  const hit = cache.get(s)
  if (hit) return hit
  const out: Record<string, string> = {}
  for (const decl of s.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim()
    const value = decl.slice(i + 1).trim()
    if (!prop || !value) continue
    const key = prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    out[key] = value
  }
  cache.set(s, out as CSSProperties)
  return out as CSSProperties
}
/** Merge design strings (later wins). */
export const cx = (...parts: (string | false | null | undefined)[]) => css(parts.filter(Boolean).join(';'))
