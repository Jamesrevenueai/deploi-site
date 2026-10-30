/**
 * Microsoft 365 / Outlook adapter (Microsoft identity platform v2 + Microsoft Graph v1.0).
 * Sending needs Mail.Send; looking a sent message up and noticing replies need Mail.ReadBasic,
 * a separate permission. Graph sendMail answers 202 Accepted: accepted for delivery, not delivered.
 * Sources: docs/platform-research/email.md.
 */
import { emailConfig } from '../config'
import type { EmailAdapter } from '../types'
import { emailFetch, formPost, sendOutcome } from './http'

const login = () => `https://login.microsoftonline.com/${encodeURIComponent(emailConfig.microsoftTenant)}/oauth2/v2.0`
const GRAPH = 'https://graph.microsoft.com/v1.0'
const BASE = ['openid', 'email', 'profile', 'offline_access', 'User.Read']
export const MS_SEND = 'Mail.Send'
export const MS_READ = 'Mail.ReadBasic'
const has = (scopes: string[], s: string) => scopes.some(x => x.toLowerCase() === s.toLowerCase() || x.toLowerCase().endsWith('/' + s.toLowerCase()))

function tokens(json: Record<string, unknown>, fallbackScopes: string[]) {
  return {
    accessToken: String(json.access_token ?? ''),
    refreshToken: json.refresh_token ? String(json.refresh_token) : null,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : null,
    scopes: typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean).map(s => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '')) : fallbackScopes,
  }
}
const odataString = (v: string) => `'${v.replace(/'/g, "''")}'`

export const microsoftAdapter: EmailAdapter = {
  provider: 'microsoft',
  label: 'Microsoft 365 / Outlook',
  configured: () => Boolean(emailConfig.microsoftClientId && emailConfig.microsoftClientSecret),
  scopesFor: ({ read }) => [...BASE, MS_SEND, ...(read ? [MS_READ] : [])],
  canSend: s => has(s, MS_SEND),
  // UNVERIFIED: setting internetMessageId on sendMail and filtering Sent Items by it; lookups are disabled below
  reliableNotFound: false,
  canRead: s => has(s, MS_READ) || has(s, 'Mail.Read') || has(s, 'Mail.ReadWrite'),

  authorizeUrl({ state, codeChallenge, scopes, loginHint }) {
    const q = new URLSearchParams({
      client_id: emailConfig.microsoftClientId, response_type: 'code', redirect_uri: emailConfig.redirectUrl, response_mode: 'query',
      scope: scopes.join(' '), state, code_challenge: codeChallenge, code_challenge_method: 'S256', prompt: 'select_account',
    })
    if (loginHint) q.set('login_hint', loginHint)
    return `${login()}/authorize?${q}`
  },
  async exchangeCode(code, verifier, scopes) {
    const r = await formPost(`${login()}/token`, { client_id: emailConfig.microsoftClientId, client_secret: emailConfig.microsoftClientSecret, grant_type: 'authorization_code', code, redirect_uri: emailConfig.redirectUrl, code_verifier: verifier, scope: scopes.join(' ') })
    if (r.status !== 200 || !r.json.access_token) throw new Error(`token exchange failed (${String(r.json.error ?? r.status)})`)
    return tokens(r.json, scopes)
  },
  async refresh(refreshToken, scopes) {
    const r = await formPost(`${login()}/token`, { client_id: emailConfig.microsoftClientId, client_secret: emailConfig.microsoftClientSecret, grant_type: 'refresh_token', refresh_token: refreshToken, scope: scopes.join(' ') })
    if (r.status !== 200 || !r.json.access_token) throw Object.assign(new Error(`token refresh failed (${String(r.json.error ?? r.status)})`), { auth: r.json.error === 'invalid_grant' || r.json.error === 'interaction_required' })
    const t = tokens(r.json, scopes)
    return { ...t, refreshToken: t.refreshToken ?? refreshToken }
  },
  async identity(accessToken) {
    const res = await emailFetch(`${GRAPH}/me?$select=mail,userPrincipalName,displayName`, { headers: { authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new Error(`could not read the account identity (${res.status})`)
    const j = (await res.json()) as { mail?: string | null; userPrincipalName?: string; displayName?: string }
    const address = (j.mail || j.userPrincipalName || '').toLowerCase()
    if (!address.includes('@')) throw new Error('the account has no email address')
    return { address, displayName: j.displayName ?? null }
  },
  async send(_account, accessToken, msg) {
    const rcpt = (a: string) => ({ emailAddress: { address: a } })
    const body = {
      message: {
        subject: msg.content.subject,
        body: { contentType: 'Text', content: msg.content.bodyText },
        toRecipients: msg.to.map(rcpt),
        ccRecipients: msg.cc.map(rcpt),
        internetMessageHeaders: [{ name: 'X-Deploi-Message', value: msg.deploiId }],
        attachments: msg.content.attachments.map(a => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentType: a.contentType, contentBytes: a.contentBase64 })),
      },
      saveToSentItems: true,
    }
    return sendOutcome(
      () => emailFetch(`${GRAPH}/me/sendMail`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      async () => ({ outcome: 'accepted', providerMessageId: null, providerThreadId: null, evidence: 'Microsoft Graph answered 202 Accepted (accepted for delivery)' }))
  },
  // Graph assigns its own internetMessageId and offers no idempotency key; until a reliable lookup is verified on a
  // test tenant, Deploi does not claim it can find a sent message, so an uncertain send stays "Delivery unknown".
  async findSent() { return null },
  async listReplies(account, accessToken, ref) {
    if (!this.canRead(account.scopes) || !ref.providerThreadId) return null
    const q = new URLSearchParams({ $filter: `conversationId eq ${odataString(ref.providerThreadId)}`, $select: 'from,receivedDateTime', $top: '50' })
    const res = await emailFetch(`${GRAPH}/me/messages?${q}`, { headers: { authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new Error(`conversation read failed (${res.status})`)
    const j = (await res.json()) as { value?: { from?: { emailAddress?: { address?: string } }; receivedDateTime?: string }[] }
    return (j.value ?? []).map(m => ({ from: (m.from?.emailAddress?.address ?? '').toLowerCase(), receivedAt: m.receivedDateTime ?? '' }))
      .filter(m => m.from && m.from !== account.address.toLowerCase())
  },
  // an app cannot revoke a user's grant through an API; the merchant removes it in their account settings
  revoke: async () => 'not_supported',
}
