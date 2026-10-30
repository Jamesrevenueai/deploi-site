/**
 * Gmail adapter (Google OAuth 2.0 + Gmail API v1). Sending needs only gmail.send. Looking a sent
 * message up after an uncertain outcome, and noticing replies, need gmail.readonly, which is a
 * separate permission the merchant grants only for a task that needs it.
 * Sources: docs/platform-research/email.md.
 */
import { emailConfig } from '../config'
import { base64url, buildMime } from '../mime'
import type { EmailAdapter } from '../types'
import { emailFetch, formPost, sendOutcome } from './http'

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const REVOKE = 'https://oauth2.googleapis.com/revoke'
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo'
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
export const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send'
export const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly'
const BASE = ['openid', 'email', 'profile']

function tokens(json: Record<string, unknown>, fallbackScopes: string[]) {
  return {
    accessToken: String(json.access_token ?? ''),
    refreshToken: json.refresh_token ? String(json.refresh_token) : null,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : null,
    scopes: typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : fallbackScopes,
  }
}

export const gmailAdapter: EmailAdapter = {
  provider: 'gmail',
  label: 'Gmail / Google Workspace',
  configured: () => Boolean(emailConfig.googleClientId && emailConfig.googleClientSecret),
  scopesFor: ({ read }) => [...BASE, GMAIL_SEND, ...(read ? [GMAIL_READ] : [])],
  canSend: s => s.includes(GMAIL_SEND) || s.includes('https://www.googleapis.com/auth/gmail.compose') || s.includes('https://mail.google.com/'),
  // UNVERIFIED: that Gmail keeps the Message-ID we set, so a miss on rfc822msgid: is not proof of "not sent"
  reliableNotFound: false,
  canRead: s => s.includes(GMAIL_READ) || s.includes('https://www.googleapis.com/auth/gmail.modify') || s.includes('https://mail.google.com/'),

  authorizeUrl({ state, codeChallenge, scopes, loginHint }) {
    const q = new URLSearchParams({
      client_id: emailConfig.googleClientId, redirect_uri: emailConfig.redirectUrl, response_type: 'code', scope: scopes.join(' '),
      state, code_challenge: codeChallenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
    })
    if (loginHint) q.set('login_hint', loginHint)
    return `${AUTH}?${q}`
  },
  async exchangeCode(code, verifier, scopes) {
    const r = await formPost(TOKEN, { code, client_id: emailConfig.googleClientId, client_secret: emailConfig.googleClientSecret, redirect_uri: emailConfig.redirectUrl, grant_type: 'authorization_code', code_verifier: verifier })
    if (r.status !== 200 || !r.json.access_token) throw new Error(`token exchange failed (${String(r.json.error ?? r.status)})`)
    return tokens(r.json, scopes)
  },
  async refresh(refreshToken, scopes) {
    const r = await formPost(TOKEN, { refresh_token: refreshToken, client_id: emailConfig.googleClientId, client_secret: emailConfig.googleClientSecret, grant_type: 'refresh_token' })
    if (r.status !== 200 || !r.json.access_token) throw Object.assign(new Error(`token refresh failed (${String(r.json.error ?? r.status)})`), { auth: r.json.error === 'invalid_grant' })
    const t = tokens(r.json, scopes)
    return { ...t, refreshToken: t.refreshToken ?? refreshToken }
  },
  async identity(accessToken) {
    const res = await emailFetch(USERINFO, { headers: { authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new Error(`could not read the account identity (${res.status})`)
    const j = (await res.json()) as { email?: string; name?: string; email_verified?: boolean }
    if (!j.email) throw new Error('the account has no email address')
    return { address: j.email.toLowerCase(), displayName: j.name ?? null }
  },
  async send(_account, accessToken, msg) {
    const raw = base64url(buildMime(msg))
    return sendOutcome(
      () => emailFetch(`${API}/messages/send`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw }) }),
      async res => { const j = (await res.json().catch(() => ({}))) as { id?: string; threadId?: string }; return { outcome: 'accepted', providerMessageId: j.id ?? null, providerThreadId: j.threadId ?? null, evidence: 'Gmail returned a message id for the sent message' } })
  },
  async findSent(account, accessToken, internetMessageId) {
    if (!this.canRead(account.scopes)) return null
    const q = new URLSearchParams({ q: `rfc822msgid:${internetMessageId.replace(/[<>]/g, '')}`, includeSpamTrash: 'false' })
    const res = await emailFetch(`${API}/messages?${q}`, { headers: { authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new Error(`lookup failed (${res.status})`)
    const j = (await res.json()) as { messages?: { id: string; threadId: string }[] }
    const m = j.messages?.[0]
    return m ? { found: true, providerMessageId: m.id, providerThreadId: m.threadId } : { found: false }
  },
  async listReplies(account, accessToken, ref) {
    if (!this.canRead(account.scopes) || !ref.providerThreadId) return null
    const q = new URLSearchParams({ format: 'metadata' })
    q.append('metadataHeaders', 'From'); q.append('metadataHeaders', 'Date')
    const res = await emailFetch(`${API}/threads/${encodeURIComponent(ref.providerThreadId)}?${q}`, { headers: { authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new Error(`thread read failed (${res.status})`)
    const j = (await res.json()) as { messages?: { internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }[] }
    return (j.messages ?? []).map(m => {
      const h = (n: string) => m.payload?.headers?.find(x => x.name.toLowerCase() === n)?.value ?? ''
      const from = (/<([^>]+)>/.exec(h('from'))?.[1] ?? h('from')).trim().toLowerCase()
      return { from, receivedAt: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date(h('date') || 0).toISOString() }
    }).filter(m => m.from && m.from !== account.address.toLowerCase())
  },
  async revoke({ accessToken, refreshToken }) {
    const token = refreshToken ?? accessToken
    if (!token) return 'not_supported'
    try { const r = await formPost(REVOKE, { token }); return r.status === 200 ? 'revoked' : 'failed' } catch { return 'failed' }
  },
}
