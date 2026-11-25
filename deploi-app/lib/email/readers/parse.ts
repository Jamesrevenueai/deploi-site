/**
 * Safe parsing of provider messages (Gmail `messages.get` payloads, Graph message resources) into one
 * shape. Everything is bounded: header count and length, MIME depth and part count, decoded text size.
 * Attachments are metadata only (name, type, size): their content is never downloaded, decoded or stored.
 * Malformed input (bad base64, unknown charsets, missing parts, odd headers) never throws: it yields
 * an empty or partial text instead. Message content is data and is never interpreted.
 */
import { isAddress } from '../mime'
import { LOOP_HEADERS } from '../adapters/deploi'
import { htmlToText } from './html'

export const MAX_TEXT = 100_000
const MAX_HEADERS = 400
const MAX_HEADER_VALUE = 2000
const MAX_PARTS = 200
const MAX_DEPTH = 12

export type ProviderAttachment = { filename: string; contentType: string; size: number | null }
export type ProviderMessage = {
  providerMessageId: string
  providerThreadId: string | null
  internetMessageId: string | null
  from: string
  to: string[]
  cc: string[]
  subject: string
  text: string
  inReplyTo: string | null
  references: string[]
  receivedAt: string
  /** loop and bulk headers only, lower-case names */
  headers: Record<string, string>
  /** spf / dkim / dmarc as reported by the receiving server (Authentication-Results), or null when absent */
  authentication: Record<string, string> | null
  attachments: ProviderAttachment[]
  /** the text was cut, or not downloaded at all because the message is too large */
  truncated: boolean
}

/** Headers kept for loop, bulk and authentication decisions. */
export const KEPT_HEADERS = LOOP_HEADERS

const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max)
const oneLine = (v: unknown, max: number) => clean(v, max * 2).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)

/** Message-IDs in a header (<...> tokens), at most 50. */
export const messageIds = (v: string | undefined | null) => ((v ?? '').match(/<[^<>\s]{1,250}>/g) ?? []).slice(0, 50)

/** Addresses from an address-list header ("A" <a@x>, b@y, "Last, First" <c@z>), lower case, valid only, at most 100. */
export function parseAddressList(v: string | undefined | null): string[] {
  const s = String(v ?? '').slice(0, 20_000)
  const out: string[] = []
  let cur = '', quote = false, angle = 0
  const push = () => {
    const m = /<([^<>]+)>/.exec(cur)
    const a = (m ? m[1] : cur.replace(/\(.*?\)/g, '')).trim().replace(/^mailto:/i, '').toLowerCase()
    if (a && isAddress(a) && !out.includes(a)) out.push(a)
    cur = ''
  }
  for (const ch of s) {
    if (ch === '"' ) quote = !quote
    else if (!quote && ch === '<') angle++
    else if (!quote && ch === '>') angle = Math.max(0, angle - 1)
    if ((ch === ',' || ch === ';') && !quote && angle === 0) { push(); if (out.length >= 100) break; continue }
    cur += ch
  }
  if (out.length < 100) push()
  return out
}

/**
 * spf / dkim / dmarc from the receiving server's Authentication-Results header (RFC 8601). Only the first
 * header from `trustedServer` (when given) counts: the receiving server adds its own on top, and anything
 * below it could have been written by the sender.
 */
export function parseAuthResults(values: string[], trustedServer?: string | null): Record<string, string> | null {
  const v = values.find(x => !trustedServer || x.trim().toLowerCase().startsWith(trustedServer.toLowerCase())) ?? null
  if (!v) return null
  const out: Record<string, string> = {}
  for (const k of ['spf', 'dkim', 'dmarc']) {
    const m = new RegExp(`(?:^|[;\\s])${k}=([a-z_]+)`, 'i').exec(v)
    if (m) out[k] = m[1].toLowerCase()
  }
  return Object.keys(out).length ? out : null
}

/** Decode Gmail's base64url body data with a byte budget; returns null on malformed data. */
export function decodeBase64Url(data: unknown, maxBytes: number): Buffer | null {
  if (typeof data !== 'string' || !data) return null
  const s = data.slice(0, Math.ceil(maxBytes / 3) * 4 + 4).replace(/\s+/g, '')
  if (!/^[A-Za-z0-9_\-+/]*={0,2}$/.test(s)) return null
  try { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').subarray(0, maxBytes) } catch { return null }
}

export function decodeText(buf: Buffer, charset: string | null): string {
  const cs = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '')
  try { return new TextDecoder(cs || 'utf-8', { fatal: false }).decode(buf) } catch { return buf.toString('utf8') }
}

export { htmlToText }

const charsetOf = (contentType: string | undefined) => /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? '')?.[1] ?? null

type GmailPart = { partId?: string; mimeType?: string; filename?: string; headers?: { name?: string; value?: string }[]; body?: { attachmentId?: string; size?: number; data?: string }; parts?: GmailPart[] }
export type GmailMessage = { id?: string; threadId?: string; labelIds?: string[]; internalDate?: string; sizeEstimate?: number; snippet?: string; payload?: GmailPart }

/** Header lookup over a Gmail headers list: all values for a name, in order. */
export function gmailHeaders(m: GmailMessage): Map<string, string[]> {
  const h = new Map<string, string[]>()
  const list = Array.isArray(m.payload?.headers) ? m.payload!.headers!.slice(0, MAX_HEADERS) : []
  for (const x of list) {
    if (!x || typeof x.name !== 'string') continue
    const k = x.name.toLowerCase().slice(0, 100)
    h.set(k, [...(h.get(k) ?? []), clean(x.value, MAX_HEADER_VALUE)])
  }
  return h
}

function keptHeaders(get: (n: string) => string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of KEPT_HEADERS) { const v = get(k); if (v !== undefined) out[k] = oneLine(v, 300) }
  return out
}

/** Gmail message (format=full, or metadata when the message is too large) -> ProviderMessage. Null without an id. */
export function parseGmailMessage(m: GmailMessage, opts: { bodyFetched: boolean }): ProviderMessage | null {
  if (!m || typeof m.id !== 'string' || !m.id) return null
  const h = gmailHeaders(m)
  const first = (n: string) => h.get(n)?.[0]
  let text = '', html = '', truncated = !opts.bodyFetched
  const attachments: ProviderAttachment[] = []
  let parts = 0
  const walk = (p: GmailPart | undefined, depth: number) => {
    if (!p || typeof p !== 'object' || depth > MAX_DEPTH || ++parts > MAX_PARTS) return
    const type = String(p.mimeType ?? '').toLowerCase()
    const partHeaders = Array.isArray(p.headers) ? p.headers : []
    const ctype = partHeaders.find(x => x?.name?.toLowerCase() === 'content-type')?.value
    const disp = String(partHeaders.find(x => x?.name?.toLowerCase() === 'content-disposition')?.value ?? '').toLowerCase()
    const isAttachment = Boolean(p.filename) || Boolean(p.body?.attachmentId) || disp.startsWith('attachment')
    if (isAttachment && !type.startsWith('multipart/')) {
      if (attachments.length < 50) {
        const size = Number(p.body?.size)
        attachments.push({ filename: oneLine(p.filename, 200) || 'attachment', contentType: oneLine(type, 100) || 'application/octet-stream', size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : null })
      }
      return
    }
    if (Array.isArray(p.parts)) { for (const c of p.parts) walk(c, depth + 1); return }
    if (!opts.bodyFetched) return
    if (type === 'text/plain' || type === 'text/html' || (!type && depth === 0)) {
      const budget = (MAX_TEXT - (type === 'text/html' ? html.length : text.length)) * 4
      if (budget <= 0) { truncated = true; return }
      const buf = decodeBase64Url(p.body?.data, budget)
      if (!buf) return
      const s = decodeText(buf, charsetOf(ctype))
      if (type === 'text/html') html += s; else text += (text ? '\n' : '') + s
    }
  }
  walk(m.payload, 0)
  if (!text.trim() && html) text = htmlToText(html)
  text = clean(text.replace(/\r\n/g, '\n'), MAX_TEXT * 2)
  if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); truncated = true }
  const internal = Number(m.internalDate)
  const date = Number.isFinite(internal) && internal > 0 ? new Date(internal) : new Date(first('date') ?? '')
  return {
    providerMessageId: oneLine(m.id, 200),
    providerThreadId: typeof m.threadId === 'string' ? oneLine(m.threadId, 200) : null,
    internetMessageId: messageIds(first('message-id'))[0] ?? null,
    from: parseAddressList(first('from'))[0] ?? '',
    to: parseAddressList((h.get('to') ?? []).join(', ')),
    cc: parseAddressList((h.get('cc') ?? []).join(', ')),
    subject: oneLine(first('subject'), 500),
    text,
    inReplyTo: messageIds(first('in-reply-to'))[0] ?? null,
    references: messageIds(first('references')),
    receivedAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
    headers: keptHeaders(n => first(n)),
    // Gmail's receiving server writes "Authentication-Results: mx.google.com; ..." on top
    authentication: parseAuthResults(h.get('authentication-results') ?? [], 'mx.google.com'),
    attachments,
    truncated,
  }
}

type GraphAddr = { emailAddress?: { address?: string; name?: string } }
export type GraphMessage = {
  id?: string; conversationId?: string; internetMessageId?: string; subject?: string; from?: GraphAddr; sender?: GraphAddr
  toRecipients?: GraphAddr[]; ccRecipients?: GraphAddr[]; receivedDateTime?: string; isDraft?: boolean
  body?: { contentType?: string; content?: string }; internetMessageHeaders?: { name?: string; value?: string }[]
  attachments?: { name?: string; contentType?: string; size?: number }[]; '@removed'?: unknown
}

const graphAddrs = (v: GraphAddr[] | undefined) => (Array.isArray(v) ? v.slice(0, 100) : []).map(a => String(a?.emailAddress?.address ?? '').trim().toLowerCase()).filter(a => isAddress(a))

/** Graph message (with internetMessageHeaders and attachment metadata) -> ProviderMessage. Null without an id. */
export function parseGraphMessage(m: GraphMessage): ProviderMessage | null {
  if (!m || typeof m.id !== 'string' || !m.id) return null
  const hs = new Map<string, string[]>()
  for (const x of (Array.isArray(m.internetMessageHeaders) ? m.internetMessageHeaders : []).slice(0, MAX_HEADERS)) {
    if (!x || typeof x.name !== 'string') continue
    const k = x.name.toLowerCase().slice(0, 100)
    hs.set(k, [...(hs.get(k) ?? []), clean(x.value, MAX_HEADER_VALUE)])
  }
  const first = (n: string) => hs.get(n)?.[0]
  const raw = clean(m.body?.content, MAX_TEXT * 4)
  let text = String(m.body?.contentType ?? '').toLowerCase() === 'html' ? htmlToText(raw) : raw.replace(/\r\n/g, '\n')
  let truncated = String(m.body?.content ?? '').length > MAX_TEXT * 4
  if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); truncated = true }
  const at = new Date(m.receivedDateTime ?? '')
  const attachments = (Array.isArray(m.attachments) ? m.attachments.slice(0, 50) : []).map(a => {
    const size = Number(a?.size)
    return { filename: oneLine(a?.name, 200) || 'attachment', contentType: oneLine(a?.contentType, 100) || 'application/octet-stream', size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : null }
  })
  const fromAddr = graphAddrs([m.from ?? m.sender ?? {}])[0] ?? ''
  return {
    providerMessageId: oneLine(m.id, 300),
    providerThreadId: typeof m.conversationId === 'string' ? oneLine(m.conversationId, 300) : null,
    internetMessageId: messageIds(m.internetMessageId)[0] ?? null,
    from: fromAddr,
    to: graphAddrs(m.toRecipients),
    cc: graphAddrs(m.ccRecipients),
    subject: oneLine(m.subject, 500),
    text,
    inReplyTo: messageIds(first('in-reply-to'))[0] ?? null,
    references: messageIds(first('references')),
    receivedAt: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
    headers: keptHeaders(n => first(n)),
    // Exchange Online writes its own Authentication-Results (no authserv-id prefix) on top; only the first counts
    authentication: parseAuthResults((hs.get('authentication-results') ?? []).slice(0, 1)),
    attachments,
    truncated,
  }
}
