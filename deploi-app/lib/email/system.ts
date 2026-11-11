/**
 * System email: messages from the Deploi platform itself (member invitations, support notices, operations
 * alerts), never from an agent or an organization's mailbox. Sent from hello@<site domain> through Resend.
 *
 *  - Gate: the same EMAIL_LIVE_SENDS switch as every other send (lib/email/config.ts). "off" (default) holds
 *    the message: it is recorded with status "held" and nothing leaves Deploi. "allowlist" sends only to
 *    EMAIL_TEST_RECIPIENTS. "all" sends. Without RESEND_API_KEY every message is held.
 *  - Idempotency: each message has a caller-chosen key (e.g. "invite:<id>:<nonce digest>"). The first call
 *    records it; a repeat with the same key returns the recorded outcome and never sends a second copy. Resend
 *    also receives an Idempotency-Key derived from it, so a retry after an uncertain outcome cannot duplicate.
 *  - Content: templates render subject, text and HTML; every value interpolated into HTML is escaped, and CR/LF
 *    are removed from the subject. Values named in `secretParams` (single-use links) are replaced by
 *    "[link removed]" in the stored copy, so the record in system_emails cannot be used to accept an invite.
 *  - Record: system_emails (staff read only).
 * Resend request shape: https://resend.com/docs/api-reference/emails/send-email
 */
import { createHash } from 'node:crypto'
import { admin } from '../db'
import { env, COMPANY_NAME } from '../env'
import { log } from '../log'
import { emailConfig, liveSendAllowed } from './config'
import { emailFetch, sendOutcome } from './adapters/http'

export const RESEND_EMAILS_URL = 'https://api.resend.com/emails'

export type Rendered = { subject: string; text: string; html: string }
export type SystemTemplate = (p: Record<string, string>) => Rendered

const AMP = /[&<>"']/g
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (s: string) => String(s).replace(AMP, c => ESC[c])

/** Tagged template that escapes every interpolated value (use raw() for markup that is already safe). */
type Raw = { __raw: string }
export const raw = (s: string): Raw => ({ __raw: s })
export function html(strings: TemplateStringsArray, ...values: (string | number | Raw)[]): string {
  return strings.reduce((out, s, i) => out + s + (i < values.length ? (typeof values[i] === 'object' ? (values[i] as Raw).__raw : escapeHtml(String(values[i]))) : ''), '')
}

/** Wrap a template's HTML body in the shared plain layout. */
export function layout(body: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#14161a">`
    + `<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:24px">${body}`
    + `<p style="margin-top:24px;font-size:12px;color:#6b7280">${escapeHtml(COMPANY_NAME)} · ${escapeHtml(systemFromAddress())}</p></div></body></html>`
}
export const button = (href: string, label: string) => html`<p><a href="${href}" style="display:inline-block;background:#14161a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px">${label}</a></p>`

const TEMPLATES = new Map<string, SystemTemplate>()
/** Register a template (other modules add their own, e.g. operations alerts). Names are unique. */
export function registerSystemTemplate(name: string, fn: SystemTemplate) {
  if (!/^[a-z0-9_.-]{1,80}$/.test(name)) throw new Error(`invalid template name ${name}`)
  TEMPLATES.set(name, fn)
}
export function renderSystemEmail(name: string, params: Record<string, string>): Rendered {
  const t = TEMPLATES.get(name)
  if (!t) throw new Error(`unknown system email template ${name}`)
  const r = t(params)
  return { subject: r.subject.replace(/[\r\n]+/g, ' ').trim().slice(0, 300), text: r.text, html: r.html }
}

/** The site's domain (NEXT_PUBLIC_SITE_URL's host without www), or SYSTEM_MAIL_DOMAIN when set. */
export function systemMailDomain(): string {
  const set = (process.env.SYSTEM_MAIL_DOMAIN ?? '').trim().toLowerCase().replace(/^@/, '')
  if (set) return set
  try { return new URL(env.siteUrl).hostname.replace(/^www\./, '') } catch { return 'getdeploi.com' }
}
export const systemFromAddress = () => `support@${systemMailDomain()}`
/** Where staff notices go: SUPPORT_INBOX, else support@<site domain>. */
export const supportInbox = () => ((process.env.SUPPORT_INBOX ?? '').trim().toLowerCase() || systemFromAddress())

const ADDRESS = /^[^\s@<>(),;:"[\]\\]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i

export type SystemEmailInput = {
  /** idempotency key: one logical message, sent at most once */
  key: string
  template: string
  to: string
  params: Record<string, string>
  orgId?: string | null
  related?: Record<string, unknown>
  /** params that are single-use secrets (links): replaced in the stored copy */
  secretParams?: string[]
  replyTo?: string | null
}
export type SystemEmailStatus = 'pending' | 'held' | 'sent' | 'failed' | 'uncertain'
export type SystemEmailResult = { id: string; status: SystemEmailStatus; reason: string | null; duplicate: boolean }

type Row = { id: string; status: SystemEmailStatus; status_reason: string | null; attempts: number }

/** Send (or hold) one platform message. Never throws for a provider failure: the outcome is recorded and returned. */
export async function sendSystemEmail(input: SystemEmailInput): Promise<SystemEmailResult> {
  const to = input.to.trim().toLowerCase()
  if (!ADDRESS.test(to) || to.length > 320) throw new Error('system email: invalid recipient address')
  if (!input.key || input.key.length > 200) throw new Error('system email: an idempotency key of 1 to 200 characters is required')
  const rendered = renderSystemEmail(input.template, input.params)
  const redactedParams = { ...input.params }
  for (const k of input.secretParams ?? []) if (k in redactedParams) redactedParams[k] = '[link removed]'
  const stored = input.secretParams?.length ? renderSystemEmail(input.template, redactedParams) : rendered
  const from = systemFromAddress()

  const row = await admin(async db => {
    const ins = await db.one<Row>(
      `insert into system_emails (idempotency_key, template, org_id, to_address, from_address, subject, body_text, body_html, related)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (idempotency_key) do nothing returning id, status, status_reason, attempts`,
      [input.key, input.template, input.orgId ?? null, to, from, stored.subject, stored.text, stored.html, JSON.stringify(input.related ?? {})])
    if (ins) return { ...ins, fresh: true }
    const old = await db.one<Row>('select id, status, status_reason, attempts from system_emails where idempotency_key = $1', [input.key])
    return { ...old!, fresh: false }
  })
  // a repeat of a message already decided (sent, held, or possibly sent) is not sent again
  if (!row.fresh && row.status !== 'failed' && row.status !== 'pending') return { id: row.id, status: row.status, reason: row.status_reason, duplicate: true }

  const finish = async (status: SystemEmailStatus, reason: string | null, providerId: string | null = null) => {
    await admin(db => db.query(
      `update system_emails set status = $2, status_reason = $3, provider_message_id = coalesce($4, provider_message_id), attempts = attempts + $5, sent_at = case when $2 = 'sent' then now() else sent_at end where id = $1`,
      [row.id, status, reason?.slice(0, 500) ?? null, providerId, status === 'held' ? 0 : 1]))
    log.info('system_email.outcome', { id: row.id, template: input.template, status })
    return { id: row.id, status, reason, duplicate: !row.fresh }
  }

  if (!emailConfig.resendKey) return finish('held', 'system email is not configured in this environment (RESEND_API_KEY); nothing was sent')
  const gate = liveSendAllowed([to])
  if (!gate.ok) return finish('held', gate.reason)

  const res = await sendOutcome(
    () => emailFetch(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${emailConfig.resendKey}`, 'content-type': 'application/json', 'idempotency-key': `deploi-system-${createHash('sha256').update(input.key).digest('hex').slice(0, 48)}` },
      body: JSON.stringify({
        from: `${COMPANY_NAME} <${from}>`, to: [to], subject: rendered.subject, text: rendered.text, html: rendered.html,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        headers: { 'X-Deploi-System': row.id },
      }),
    }),
    async r => {
      const j = (await r.json().catch(() => ({}))) as { id?: string }
      return { outcome: 'accepted', providerMessageId: j.id ?? null, providerThreadId: null, evidence: 'Resend accepted the message' }
    })
  if (res.outcome === 'accepted') return finish('sent', null, res.providerMessageId)
  if (res.outcome === 'uncertain') return finish('uncertain', res.message)
  if (res.outcome === 'throttled') return finish('failed', `the provider is limiting sends (${res.code}); try again later`)
  return finish('failed', res.message)
}

// ------------------------------------------------------------------ the platform's own templates

registerSystemTemplate('member_invite', p => ({
  subject: `${p.inviter} invited you to ${p.org} on ${COMPANY_NAME}`,
  text: [
    `${p.inviter} invited you to join ${p.org} on ${COMPANY_NAME} as ${p.roleArticle} ${p.role}.`,
    '',
    `Accept the invitation: ${p.link}`,
    '',
    `The link works once, only for ${p.email}, and expires on ${p.expires}.`,
    `If you did not expect this invitation, ignore this email.`,
  ].join('\n'),
  html: layout(html`<p>${p.inviter} invited you to join <strong>${p.org}</strong> on ${COMPANY_NAME} as ${p.roleArticle} <strong>${p.role}</strong>.</p>`
    + button(p.link, 'Accept the invitation')
    + html`<p style="font-size:14px;color:#4b5563">The link works once, only for ${p.email}, and expires on ${p.expires}. If you did not expect this invitation, ignore this email.</p>`),
}))

registerSystemTemplate('support_ticket_staff', p => ({
  subject: `[${p.ref}] ${p.category}: ${p.subject}`,
  text: [`New support request ${p.ref} from ${p.from} (${p.org}).`, `Category: ${p.category}`, p.caseRef ? `Case: ${p.caseRef}` : '', p.page ? `Page: ${p.page}` : '', '', p.message, '', `Open it: ${p.link}`].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'),
  html: layout(html`<p>New support request <strong>${p.ref}</strong> from ${p.from} (${p.org}).</p><p>Category: ${p.category}${p.caseRef ? raw(html`<br>Case: ${p.caseRef}`) : ''}${p.page ? raw(html`<br>Page: ${p.page}`) : ''}</p><blockquote style="white-space:pre-wrap;border-left:3px solid #e3e6ea;margin:0;padding-left:12px">${p.message}</blockquote>` + button(p.link, 'Open the request')),
}))

registerSystemTemplate('support_customer_reply', p => ({
  subject: `[${p.ref}] New message from ${p.from}`,
  text: [`${p.from} (${p.org}) replied on ${p.ref}.`, '', p.message, '', `Open it: ${p.link}`].join('\n'),
  html: layout(html`<p>${p.from} (${p.org}) replied on <strong>${p.ref}</strong>.</p><blockquote style="white-space:pre-wrap;border-left:3px solid #e3e6ea;margin:0;padding-left:12px">${p.message}</blockquote>` + button(p.link, 'Open the request')),
}))

registerSystemTemplate('support_reply', p => ({
  subject: `Re: [${p.ref}] ${p.subject}`,
  text: [`${COMPANY_NAME} support replied to your request ${p.ref}:`, '', p.message, '', `See the whole conversation and reply: ${p.link}`].join('\n'),
  html: layout(html`<p>${COMPANY_NAME} support replied to your request <strong>${p.ref}</strong>:</p><blockquote style="white-space:pre-wrap;border-left:3px solid #e3e6ea;margin:0;padding-left:12px">${p.message}</blockquote>` + button(p.link, 'See the conversation')),
}))

registerSystemTemplate('contact_staff', p => ({
  subject: `Website contact (${p.topic}) from ${p.name}`,
  text: [`${p.name} <${p.email}>${p.company ? ` from ${p.company}` : ''} wrote through the website contact form (${p.topic}):`, '', p.message].join('\n'),
  html: layout(html`<p>${p.name} &lt;${p.email}&gt;${p.company ? raw(html` from ${p.company}`) : ''} wrote through the website contact form (${p.topic}):</p><blockquote style="white-space:pre-wrap;border-left:3px solid #e3e6ea;margin:0;padding-left:12px">${p.message}</blockquote>`),
}))

/**
 * A plain notice (billing and operations alerts): params.subject, params.body (plain text, paragraphs separated
 * by blank lines) and optionally params.link + params.linkLabel. Everything is escaped.
 */
registerSystemTemplate('notice', p => ({
  subject: p.subject,
  text: [p.body, ...(p.link ? ['', `${p.linkLabel || 'Open'}: ${p.link}`] : [])].join('\n'),
  html: layout(p.body.split(/\n{2,}/).map(par => html`<p>${par}</p>`).join('') + (p.link ? button(p.link, p.linkLabel || 'Open') : '')),
}))
