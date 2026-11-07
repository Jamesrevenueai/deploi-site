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
/** inbox reading (bodies): Email Operations only, when the owner turns it on */
export const MS_READ_INBOX = 'Mail.Read'
/** Outlook workspace (launch build): read, organise and send mail, and read and write the calendar */
export const MS_MAIL_RW = 'Mail.ReadWrite'
export const MS_CALENDAR = 'Calendars.ReadWrite'
export const canUseCalendar = (s: string[]) => has(s, MS_CALENDAR)
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
  scopesFor: ({ read, inbox, calendar }) => calendar ? [...BASE, MS_SEND, MS_MAIL_RW, MS_CALENDAR] : [...BASE, MS_SEND, ...(inbox ? [MS_READ_INBOX] : read ? [MS_READ] : [])],
  canSend: s => has(s, MS_SEND),
  // UNVERIFIED: setting internetMessageId on sendMail and filtering Sent Items by it; lookups are disabled below
  reliableNotFound: false,
  canRead: s => has(s, MS_READ) || has(s, 'Mail.Read') || has(s, 'Mail.ReadWrite'),
  canReadInbox: s => has(s, MS_READ_INBOX) || has(s, 'Mail.ReadWrite'),

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
  async send(account, accessToken, msg) {
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
    const reply = msg.providerReply?.messageId ?? null
    if (reply) return replyInThread(account.scopes, accessToken, reply, msg.providerReply?.threadId ?? null, { subject: msg.content.subject, body: msg.content.bodyText, to: msg.to.map(rcpt), cc: msg.cc.map(rcpt), attachments: body.message.attachments })
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

/**
 * A reply inside the Outlook conversation of a message read from this inbox. With Mail.ReadWrite: createReply
 * (a draft reply, threaded by Exchange), PATCH the exact approved text and recipients, then send. With
 * Mail.Send only (what Deploi asks for): POST /messages/{id}/reply with the message (recipients set
 * explicitly, so no one else on the original is added). Both answer 202 Accepted on send.
 * Sources: learn.microsoft.com/graph/api/message-createreply, /graph/api/message-reply, /graph/api/message-send.
 */
async function replyInThread(scopes: string[], accessToken: string, messageId: string, conversationId: string | null,
  m: { subject: string; body: string; to: unknown[]; cc: unknown[]; attachments: unknown[] }) {
  const auth = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }
  const id = encodeURIComponent(messageId)
  const message = { subject: m.subject, body: { contentType: 'Text', content: m.body }, toRecipients: m.to, ccRecipients: m.cc, ...(m.attachments.length ? { attachments: m.attachments } : {}) }
  const accepted = async () => ({ outcome: 'accepted' as const, providerMessageId: null, providerThreadId: conversationId, evidence: 'Microsoft Graph answered 202 Accepted to the reply (accepted for delivery)' })
  if (has(scopes, 'Mail.ReadWrite')) {
    // nothing is sent until the last call: a failure before it is a definite "not sent"
    const draft = await emailFetch(`${GRAPH}/me/messages/${id}/createReply`, { method: 'POST', headers: auth, body: '{}' }).catch(() => null)
    if (!draft || draft.status !== 201) return { outcome: 'rejected' as const, code: draft?.status === 401 ? 'auth' : `create_reply_${draft?.status ?? 'network'}`, message: 'Outlook did not create the reply draft; nothing was sent', auth: draft?.status === 401 }
    const d = (await draft.json().catch(() => ({}))) as { id?: string }
    if (!d.id) return { outcome: 'rejected' as const, code: 'create_reply', message: 'Outlook did not return the reply draft; nothing was sent' }
    const patched = await emailFetch(`${GRAPH}/me/messages/${encodeURIComponent(d.id)}`, { method: 'PATCH', headers: auth, body: JSON.stringify(message) }).catch(() => null)
    if (!patched || !patched.ok) return { outcome: 'rejected' as const, code: 'update_reply', message: 'Outlook did not accept the reply text; nothing was sent (the draft stays in Drafts)' }
    return sendOutcome(() => emailFetch(`${GRAPH}/me/messages/${encodeURIComponent(d.id!)}/send`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-length': '0' } }), accepted)
  }
  return sendOutcome(() => emailFetch(`${GRAPH}/me/messages/${id}/reply`, { method: 'POST', headers: auth, body: JSON.stringify({ message }) }), accepted)
}
