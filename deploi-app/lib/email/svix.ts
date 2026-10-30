/** Signature check for inbound webhooks from Resend (svix). */
import { createHmac, timingSafeEqual } from 'node:crypto'

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
