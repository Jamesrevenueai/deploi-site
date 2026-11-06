/**
 * One-click unsubscribe for agent mail (RFC 8058). The link in every agent message carries a signed
 * token (organization, address, message). POST (the mail client's one-click, or the button below)
 * suppresses the address for that organization: Deploi never sends to it again. GET only shows the
 * button, so link scanners that open URLs never unsubscribe anyone. Nothing here reveals the
 * organization or any other address. POST is limited per client IP (bucket unsubscribe); GET changes nothing.
 */
import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { log } from '@/lib/log'
import { verifyUnsubscribeToken } from '@/lib/email/unsubscribe'
import { suppressAddresses } from '@/lib/email/suppression'
import { hitByIp, tooManyRequests } from '@/lib/security/rate-limit'

export const dynamic = 'force-dynamic'

const page = (title: string, body: string, status = 200) => new NextResponse(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } })

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export async function GET(req: Request) {
  const t = new URL(req.url).searchParams.get('t') ?? ''
  if (!verifyUnsubscribeToken(t)) return page('Link not valid', '<h1>This link is not valid</h1><p>It may have been shortened or changed. Nothing was changed.</p>', 400)
  return page('Unsubscribe', `<h1>Stop these emails?</h1><p>You will no longer receive email from this sender's Deploi agents.</p>
<form method="post"><input type="hidden" name="t" value="${esc(t)}"><button type="submit" style="padding:.5rem 1rem">Unsubscribe</button></form>`)
}

export async function POST(req: Request) {
  const limited = await hitByIp('unsubscribe', req)
  if (!limited.allowed) return tooManyRequests(limited)
  const url = new URL(req.url)
  let t = url.searchParams.get('t') ?? ''
  const type = req.headers.get('content-type') ?? ''
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const f = await req.formData().catch(() => null)
    const v = f?.get('t')
    if (typeof v === 'string' && v) t = v
  }
  const claim = verifyUnsubscribeToken(t)
  if (!claim) return NextResponse.json({ ok: false, error: 'invalid_token' }, { status: 400 })
  try {
    await admin(async db => {
      // the message must exist, belong to that organization and have been sent to that address
      const m = await db.one<{ id: string }>(`select id from email_messages where id = $1 and org_id = $2 and $3 = any(to_addresses || cc_addresses)`, [claim.messageId, claim.orgId, claim.address])
      if (!m) throw new Error('no such message')
      await suppressAddresses(db, { orgId: claim.orgId, addresses: [claim.address], reason: 'unsubscribed', sourceMessageId: claim.messageId, detail: 'one-click unsubscribe', actor: 'recipient:unsubscribe' })
    })
  } catch (e) {
    log.warn('email.unsubscribe.refused', { reason: (e as Error).message.slice(0, 80) })
    return NextResponse.json({ ok: false, error: 'invalid_token' }, { status: 400 })
  }
  if (url.searchParams.get('t') && !type.includes('form')) return NextResponse.json({ ok: true })
  return page('Unsubscribed', '<h1>You are unsubscribed</h1><p>You will not receive these emails again.</p>')
}
