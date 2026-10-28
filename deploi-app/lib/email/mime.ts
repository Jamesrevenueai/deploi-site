/**
 * RFC 5322 / MIME message builder. Header values are validated (no CR/LF, so store data can never
 * inject headers), non-ASCII subjects and names are RFC 2047 encoded, and the body is base64 UTF-8.
 */
import { randomBytes } from 'node:crypto'
import type { OutgoingMessage } from './types'

export class UnsafeHeader extends Error { constructor(field: string) { super(`unsafe value in ${field}`); this.name = 'UnsafeHeader' } }

const ADDRESS = /^[^\s@<>(),;:"[\]\\]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
export const isAddress = (a: string) => ADDRESS.test(a) && a.length <= 254

function safe(field: string, v: string): string {
  if (/[\r\n\0]/.test(v)) throw new UnsafeHeader(field)
  return v
}
function encodeWord(v: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`
}
function mailbox(address: string, name: string | null): string {
  if (!isAddress(address)) throw new UnsafeHeader('address')
  if (!name) return address
  const n = safe('name', name).replace(/["\\]/g, '')
  return `${encodeWord(`"${n}"`) === `"${n}"` ? `"${n}"` : encodeWord(n)} <${address}>`
}
const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, m => m + '\r\n').trimEnd()

export function newInternetMessageId(domain = 'mail.deploi.invalid'): string {
  return `<${randomBytes(16).toString('hex')}@${domain}>`
}

export function buildMime(m: OutgoingMessage, date = new Date()): string {
  for (const a of [...m.to, ...m.cc]) if (!isAddress(a)) throw new UnsafeHeader('recipient')
  if (!m.to.length) throw new UnsafeHeader('to')
  safe('message-id', m.internetMessageId)
  const headers = [
    `From: ${mailbox(m.from, m.fromName)}`,
    `To: ${m.to.join(', ')}`,
    ...(m.cc.length ? [`Cc: ${m.cc.join(', ')}`] : []),
    `Subject: ${encodeWord(safe('subject', m.content.subject))}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${m.internetMessageId}`,
    `X-Deploi-Message: ${safe('x-deploi-message', m.deploiId)}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${safe('in-reply-to', m.inReplyTo)}`] : []),
    ...(m.references?.length ? [`References: ${m.references.map(r => safe('references', r)).join(' ')}`] : []),
    ...(m.replyTo ? [`Reply-To: ${mailbox(m.replyTo, null)}`] : []),
    'MIME-Version: 1.0',
  ]
  const text = ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(m.content.bodyText, 'utf8').toString('base64'))].join('\r\n')
  if (!m.content.attachments.length) return [...headers, text].join('\r\n') + '\r\n'
  const boundary = `deploi_${randomBytes(12).toString('hex')}`
  const parts = [text, ...m.content.attachments.map(a => [
    `Content-Type: ${safe('content-type', a.contentType)}; name="${safe('filename', a.filename).replace(/"/g, '')}"`,
    `Content-Disposition: attachment; filename="${a.filename.replace(/"/g, '')}"`,
    'Content-Transfer-Encoding: base64', '', wrap76(a.contentBase64),
  ].join('\r\n'))]
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts.map(p => `--${boundary}\r\n${p}`), `--${boundary}--`, ''].join('\r\n')
}

export const base64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
