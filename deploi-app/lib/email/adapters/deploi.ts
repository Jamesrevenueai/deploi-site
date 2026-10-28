/**
 * Agent mailbox adapter: each agent sends from its own address on Deploi's domain
 * (<name>.<code>@AGENT_MAIL_DOMAIN) through Resend, and suppliers reply to that address. There is no
 * OAuth and no Google or Microsoft restricted scope: the merchant forwards or copies threads to the
 * agent's address instead of granting mailbox access.
 *
 * Duplicate prevention: every send carries Idempotency-Key = the Deploi message id. Resend keeps keys
 * for 24 hours, so a resend of the same message within that window cannot go out twice. Resend cannot
 * look a sent message up by our Message-ID, so an uncertain outcome waits for the merchant (never an
 * automatic resend).
 *
 * Threading: replies are matched by the tagged Reply-To address (<local>+t-<token>@domain), which the
 * inbound webhook reports as a recipient. In-Reply-To/References headers are also set; Resend's docs do
 * not confirm it honours them, so they are a secondary match only.
 * Sources: https://resend.com/docs/api-reference/emails/send-email (Idempotency-Key, headers),
 * https://resend.com/docs/webhooks/emails/received, https://resend.com/docs/api-reference/emails/retrieve-received-email
 */
import { admin } from '../../db'
import { emailConfig } from '../config'
import type { AccountRef, EmailAdapter, OutgoingMessage, SendResult } from '../types'
import { emailFetch, sendOutcome } from './http'

export const RESEND_API = 'https://api.resend.com'
export const DEPLOI_SEND = 'deploi.send'
export const DEPLOI_INBOUND = 'deploi.inbound'

const noOauth = () => { throw new Error('agent mailboxes do not use OAuth') }

function resendBody(m: OutgoingMessage) {
  const headers: Record<string, string> = { 'X-Deploi-Message': m.deploiId }
  if (m.inReplyTo) headers['In-Reply-To'] = m.inReplyTo
  if (m.references?.length) headers['References'] = m.references.join(' ')
  return {
    from: m.fromName ? `${m.fromName.replace(/["<>\r\n]/g, '')} <${m.from}>` : m.from,
    to: m.to,
    ...(m.cc.length ? { cc: m.cc } : {}),
    subject: m.content.subject,
    text: m.content.bodyText,
    ...(m.replyTo ? { reply_to: m.replyTo } : {}),
    headers,
    ...(m.content.attachments.length ? { attachments: m.content.attachments.map(a => ({ filename: a.filename, content: a.contentBase64, content_type: a.contentType })) } : {}),
  }
}

export const deploiMailAdapter: EmailAdapter = {
  provider: 'deploi',
  label: 'Agent mailbox',
  configured: () => Boolean(emailConfig.agentMailDomain && emailConfig.resendKey),
  scopesFor: () => [DEPLOI_SEND, DEPLOI_INBOUND],
  canSend: s => s.includes(DEPLOI_SEND),
  canRead: s => s.includes(DEPLOI_INBOUND),
  reliableNotFound: false,
  authorizeUrl: noOauth,
  exchangeCode: async () => noOauth(),
  refresh: async () => noOauth(),
  identity: async () => noOauth(),

  async send(_account: AccountRef, _token: string, m: OutgoingMessage): Promise<SendResult> {
    if (!emailConfig.resendKey) return { outcome: 'rejected', code: 'not_configured', message: 'agent mail sending is not configured in this environment (RESEND_API_KEY); nothing was sent' }
    return sendOutcome(
      () => emailFetch(`${RESEND_API}/emails`, {
        method: 'POST',
        headers: { authorization: `Bearer ${emailConfig.resendKey}`, 'content-type': 'application/json', 'idempotency-key': `deploi-${m.deploiId}` },
        body: JSON.stringify(resendBody(m)),
      }),
      async res => {
        const j = (await res.json().catch(() => ({}))) as { id?: string }
        return { outcome: 'accepted', providerMessageId: j.id ?? null, providerThreadId: null, evidence: `Resend accepted the message${j.id ? ` (id ${j.id})` : ''}` }
      })
  },
  // Resend cannot search sent mail by Message-ID: an uncertain outcome stays "Delivery unknown" for the merchant
  findSent: async () => null,

  /** Replies come from the inbound webhook (email_inbound), matched to this message; content is never returned. */
  async listReplies(account, _token, ref) {
    return admin(db => db.query<{ from: string; receivedAt: string }>(
      `select i.from_address as "from", i.received_at as "receivedAt" from email_inbound i join email_messages m on m.id = i.thread_message_id
       where i.account_id = $1 and m.internet_message_id = $2 and i.classification = 'reply' order by i.received_at`, [account.id, ref.internetMessageId]))
  },
  revoke: async () => 'not_supported',
}

/**
 * Plain send from a Deploi system address (weekly summary), through the same fakeable HTTP path and with
 * an idempotency key, so a repeated call can never send the same summary twice.
 */
export async function resendSystemEmail(input: { from: string; to: string[]; subject: string; text: string; idempotencyKey: string }): Promise<SendResult> {
  if (!emailConfig.resendKey) return { outcome: 'rejected', code: 'not_configured', message: 'no email provider is configured in this environment; nothing was sent' }
  return sendOutcome(
    () => emailFetch(`${RESEND_API}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${emailConfig.resendKey}`, 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey },
      body: JSON.stringify({ from: input.from, to: input.to, subject: input.subject, text: input.text }),
    }),
    async res => { const j = (await res.json().catch(() => ({}))) as { id?: string }; return { outcome: 'accepted', providerMessageId: j.id ?? null, providerThreadId: null, evidence: 'Resend accepted the message' } })
}

/** Fetch a received email's text and headers (the webhook carries metadata only). */
export type ReceivedEmail = {
  id: string; from: string; to: string[]; cc: string[]; subject: string; text: string
  messageId: string | null; inReplyTo: string | null; references: string[]
  authentication: Record<string, string | null>; attachmentCount: number; receivedAt: string
}
export async function fetchReceivedEmail(id: string): Promise<ReceivedEmail> {
  if (!emailConfig.resendKey) throw new Error('RESEND_API_KEY is not configured')
  const res = await emailFetch(`${RESEND_API}/emails/receiving/${encodeURIComponent(id)}`, { method: 'GET', headers: { authorization: `Bearer ${emailConfig.resendKey}` } })
  if (!res.ok) throw new Error(`could not fetch the received email (HTTP ${res.status})`)
  const j = (await res.json()) as Record<string, unknown>
  const headers = Object.fromEntries(Object.entries((j.headers ?? {}) as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]))
  const ids = (v: string | undefined) => (v ?? '').match(/<[^<>\s]+>/g) ?? []
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [])
  return {
    id: String(j.id ?? id),
    from: String(j.from ?? ''),
    to: list(j.to), cc: list(j.cc),
    subject: String(j.subject ?? ''),
    text: String(j.text ?? ''),
    messageId: String(j.message_id ?? headers['message-id'] ?? '') || null,
    inReplyTo: ids(headers['in-reply-to'])[0] ?? null,
    references: ids(headers['references']),
    authentication: (j.authentication ?? {}) as Record<string, string | null>,
    attachmentCount: Array.isArray(j.attachments) ? j.attachments.length : 0,
    receivedAt: String(j.created_at ?? new Date().toISOString()),
  }
}
