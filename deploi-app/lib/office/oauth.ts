/** Small helpers shared by the OAuth providers (token answer parsing, refusal errors). */
import type { OAuthTokens } from './hubspot'

export function parseTokens(j: Record<string, unknown>, fallbackScopes: string[], scopeSep = /[ ,]+/): OAuthTokens {
  const exp = typeof j.expires_in === 'number' ? j.expires_in : typeof j.expires_in === 'string' && /^\d+$/.test(j.expires_in) ? Number(j.expires_in) : null
  return {
    accessToken: String(j.access_token ?? ''),
    refreshToken: j.refresh_token ? String(j.refresh_token) : null,
    expiresIn: exp,
    scopes: typeof j.scope === 'string' && j.scope.trim() ? j.scope.split(scopeSep).filter(Boolean) : fallbackScopes,
  }
}

/** The error a refused exchange or refresh throws: `auth` marks the connection for reconnection. Never echoes the token or the body. */
export function tokenError(label: string, what: 'exchange' | 'refresh', status: number, json: Record<string, unknown>) {
  const code = String(json.error ?? status).replace(/[^\w.-]/g, '').slice(0, 40)
  return Object.assign(new Error(`${label} token ${what} failed (${code})`), { auth: status === 400 || status === 401 || code === 'invalid_grant' })
}

/** https origin of a provider URL (no path, no credentials, lower case), or null. */
export function httpsOrigin(v: unknown): string | null {
  if (typeof v !== 'string') return null
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
    return `https://${u.hostname.toLowerCase()}`
  } catch { return null }
}
