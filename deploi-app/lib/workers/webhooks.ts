/** Signature helpers for inbound webhooks (Twilio, Resend/svix). */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Twilio: base64(HMAC-SHA1(authToken, url + sorted(key+value))) */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('')
  return createHmac('sha1', authToken).update(data).digest('base64')
}
export function verifyTwilio(authToken: string, url: string, params: Record<string, string>, header: string | null) {
  if (!header) return false
  const want = twilioSignature(authToken, url, params)
  return want.length === header.length && timingSafeEqual(Buffer.from(want), Buffer.from(header))
}

/** svix (Resend) signature: v1,base64(HMAC-SHA256(secret, `${id}.${ts}.${body}`)) */
export function verifySvix(secret: string, id: string | null, ts: string | null, sigHeader: string | null, body: string) {
  if (!id || !ts || !sigHeader) return false
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const want = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
  return sigHeader.split(' ').some(part => {
    const sig = part.split(',')[1]
    return sig && sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want))
  })
}
