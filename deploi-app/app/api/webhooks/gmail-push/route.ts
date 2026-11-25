/**
 * Gmail push (optional; GMAIL_PUSH_TOPIC + GMAIL_PUSH_AUDIENCE + GMAIL_PUSH_SERVICE_ACCOUNT). Cloud Pub/Sub
 * posts here with a Google-signed OIDC token, verified in lib/email/push.ts; a valid push only triggers a
 * normal sync of that Gmail account (after the response). Without configuration every request is refused.
 * Any 2xx acknowledges the Pub/Sub message; a refused token gets 403 (Pub/Sub retries, then drops it).
 */
import { NextResponse, after } from 'next/server'
import { log } from '@/lib/log'
import { emailConfig } from '@/lib/email/config'
import { gmailPushAccounts, verifyGooglePushToken } from '@/lib/email/push'
import { syncAccountInbox } from '@/lib/email/inbox-sync'
import { limitRejectedWebhook } from '@/lib/security/rate-limit'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: Request) {
  if (!emailConfig.gmailPushEnabled) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 })
  const bad = await verifyGooglePushToken(req.headers.get('authorization'))
  if (bad) {
    log.warn('gmail_push.rejected', { reason: bad })
    return limitRejectedWebhook(req, NextResponse.json({ ok: false }, { status: 403 }))
  }
  const raw = await req.text()
  if (raw.length > 20_000) return NextResponse.json({ ok: false, error: 'too large' }, { status: 413 })
  let body: unknown
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }) }
  const accounts = await gmailPushAccounts(body)
  after(async () => { for (const id of accounts) await syncAccountInbox(id, { actor: 'gmail:push' }).catch(e => log.error('gmail_push.sync_failed', { error: (e as Error).message.slice(0, 200) })) })
  return new NextResponse(null, { status: 204 })
}
