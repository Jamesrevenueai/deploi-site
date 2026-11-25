/** A same-site path to return to after signing in (/invite/<token> or /start); anything else is ignored (no open redirect). */
export function safeNextPath(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return /^\/(invite\/[A-Za-z0-9._-]{1,300}|start)$/.test(s) ? s : null
}
