/**
 * Unsubscribe links on agent mail. Every message an agent sends carries a signed link (body footer and
 * List-Unsubscribe header, with List-Unsubscribe-Post for one-click, RFC 8058). The token binds the
 * organization, the recipient address and the message; it is an HMAC with a server secret, so nobody
 * can unsubscribe an address they were not sent a link for. Following it (POST) suppresses the address
 * for that organization: nothing is sent to it again (lib/email/suppression.ts).
 * A person's own reply from the inbox carries no unsubscribe link.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../env'

const secret = () => (process.env.UNSUBSCRIBE_SECRET ?? '').trim() || env.appSecret
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const sign = (body: string, key: string) => createHmac('sha256', `deploi-unsubscribe:${key}`).update(body).digest('base64url')

export type UnsubscribeClaim = { orgId: string; address: string; messageId: string }

/** null when no signing secret is configured (the send then goes out without a link and the log says so). */
export function unsubscribeToken(c: UnsubscribeClaim): string | null {
  const key = secret()
  if (!key || key.length < 16) return null
  const body = b64(JSON.stringify({ o: c.orgId, a: c.address.toLowerCase(), m: c.messageId }))
  return `${body}.${sign(body, key)}`
}

export function verifyUnsubscribeToken(token: string): UnsubscribeClaim | null {
  const key = secret()
  if (!key || key.length < 16 || typeof token !== 'string' || token.length > 2000) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const want = sign(body, key)
  if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null
  try {
    const j = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { o?: unknown; a?: unknown; m?: unknown }
    if (typeof j.o !== 'string' || typeof j.a !== 'string' || typeof j.m !== 'string') return null
    if (!/^[0-9a-f-]{36}$/i.test(j.o) || !/^[0-9a-f-]{36}$/i.test(j.m)) return null
    return { orgId: j.o, address: j.a, messageId: j.m }
  } catch { return null }
}

export const UNSUBSCRIBE_PATH = '/api/webhooks/agent-mail/unsubscribe'

/** The link for one recipient of one message. A message to several recipients uses the first recipient's link in the header. */
export function unsubscribeUrl(c: UnsubscribeClaim, appUrl = env.appUrl): string | null {
  const t = unsubscribeToken(c)
  return t ? `${appUrl.replace(/\/$/, '')}${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(t)}` : null
}

/** The line added below an agent message at send time (not part of what was approved; it only offers a way out). */
export const unsubscribeFooter = (url: string) => `\n\n--\nTo stop receiving these emails from this sender: ${url}`
