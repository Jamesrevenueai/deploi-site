/**
 * Microsoft Graph change notifications for inbox reading (optional; EMAIL_GRAPH_PUSH=on).
 *  - Validation handshake: Graph posts ?validationToken=...; the token is echoed as text/plain (200).
 *  - Notifications: only those with a known subscription id and the matching clientState count
 *    (lib/email/push.ts); each triggers a normal delta sync of that account after the response (202).
 * Without configuration every request is refused.
 */
import { NextResponse, after } from 'next/server'
import { log } from '@/lib/log'
import { emailConfig } from '@/lib/email/config'
import { graphNotificationAccounts } from '@/lib/email/push'
import { syncAccountInbox } from '@/lib/email/inbox-sync'
import { limitRejectedWebhook } from '@/lib/security/rate-limit'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: Request) {
  if (!emailConfig.graphPushEnabled) return NextResponse.json({ ok: false, error: 'not_configured' }, { status: 503 })
  const token = new URL(req.url).searchParams.get('validationToken')
  if (token !== null) {
    // the token is returned as plain text, unchanged (Graph requires it); anything unusual is refused
    if (token.length > 1024 || /[\r\n<>]/.test(token)) return NextResponse.json({ ok: false }, { status: 400 })
    return new NextResponse(token, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' } })
  }
  const raw = await req.text()
  if (raw.length > 200_000) return NextResponse.json({ ok: false, error: 'too large' }, { status: 413 })
  let body: unknown
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }) }
  const { accounts, rejected } = await graphNotificationAccounts(body)
  if (rejected && !accounts.length) {
    log.warn('graph_mail.rejected', { rejected })
    return limitRejectedWebhook(req, NextResponse.json({ ok: false }, { status: 403 }))
  }
  after(async () => { for (const id of accounts) await syncAccountInbox(id, { actor: 'microsoft:notification' }).catch(e => log.error('graph_mail.sync_failed', { error: (e as Error).message.slice(0, 200) })) })
  return new NextResponse(null, { status: 202 })
}
