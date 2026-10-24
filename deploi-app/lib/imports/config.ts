/** Import-toolkit configuration, read from process.env here (lib/env.ts stays untouched). */
import type { ImportKind } from './specs'

const e = (k: string, d = '') => (process.env[k] ?? d).trim()

/** Days after the last successful import of a kind before the data is flagged stale (default 7). */
export function staleAfterDays(kind: ImportKind): number {
  const specific = Number(e(`IMPORT_STALE_DAYS_${kind.toUpperCase()}`))
  if (Number.isFinite(specific) && specific > 0) return specific
  const general = Number(e('IMPORT_STALE_DAYS', '7'))
  return Number.isFinite(general) && general > 0 ? general : 7
}
