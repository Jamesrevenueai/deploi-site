/**
 * Message content at rest and the content hash an approval is bound to. The hash covers everything
 * that matters to a recipient: sender, recipients, subject, body and each attachment's bytes. Any
 * change produces a different hash, which invalidates an earlier approval.
 */
import { createHash } from 'node:crypto'
import { canonicalJson } from '../engine/hash'
import { decryptSecret, encryptSecret } from '../connectors/credentials'
import type { MessageContent } from './types'

export function contentHash(input: { from: string; to: string[]; cc: string[]; content: MessageContent }): string {
  return createHash('sha256').update(canonicalJson({
    from: input.from.toLowerCase(),
    to: input.to.map(a => a.toLowerCase()),
    cc: input.cc.map(a => a.toLowerCase()),
    subject: input.content.subject,
    body: input.content.bodyText,
    attachments: input.content.attachments.map(a => ({ filename: a.filename, contentType: a.contentType, sha256: createHash('sha256').update(a.contentBase64).digest('hex') })),
  })).digest('hex')
}

export const encryptContent = (messageId: string, c: MessageContent) => encryptSecret(JSON.stringify(c), `email-message:${messageId}`)
export const decryptContent = (messageId: string, keyId: string, ciphertext: string): MessageContent => JSON.parse(decryptSecret(keyId, ciphertext, `email-message:${messageId}`))
export const attachmentBytes = (c: MessageContent) => c.attachments.reduce((s, a) => s + Math.floor(a.contentBase64.length * 3 / 4), 0)
