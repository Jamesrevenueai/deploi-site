import { NextResponse } from 'next/server'
import { emailConfig } from '@/lib/email/config'
import { syntheticCode, isSyntheticAddress, SYNTH_READ, SYNTH_SEND } from '@/lib/email/adapters/synthetic'

export const dynamic = 'force-dynamic'

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

/**
 * Synthetic consent screen (tests and demos only; never in production). It stands in for the provider's
 * consent page: the tester picks a synthetic address and which permissions to grant, then is sent to the
 * real callback with a synthetic code. Nothing is ever emailed.
 */
export async function GET(req: Request) {
  if (!emailConfig.syntheticAllowed) return new NextResponse('Not found', { status: 404 })
  const url = new URL(req.url)
  const state = url.searchParams.get('state') ?? ''
  const address = url.searchParams.get('address')
  if (address !== null) {
    if (!isSyntheticAddress(address)) return new NextResponse('Use an address ending in .example, .test or .invalid', { status: 400 })
    const wantRead = url.searchParams.get('want_read') === '1'
    const scopes = [...(url.searchParams.get('send') === 'on' ? [SYNTH_SEND] : []), ...(wantRead && url.searchParams.get('read') === 'on' ? [SYNTH_READ] : [])]
    const q = new URLSearchParams(url.searchParams.get('deny') ? { state, error: 'access_denied' } : { state, code: syntheticCode(address.toLowerCase(), scopes) })
    return NextResponse.redirect(new URL(`/api/email/oauth/callback?${q}`, url.origin), 303)
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic mailbox consent</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#111}label{display:block;margin:12px 0}input[type=email]{width:100%;padding:8px}button{padding:8px 14px;margin-right:8px}</style></head>
<body><h1>Synthetic mailbox</h1><p>Test only. Deploi is asking to use a synthetic mailbox. Nothing is ever emailed.</p>
<form method="get"><input type="hidden" name="state" value="${esc(state)}">${url.searchParams.get('want_read') === '1' ? '<input type="hidden" name="want_read" value="1">' : ''}
<label>Address <input type="email" name="address" value="owner@northwind-goods.example" required></label>
<label><input type="checkbox" name="send" checked> Send email as this address</label>
${url.searchParams.get('want_read') === '1' ? '<label><input type="checkbox" name="read" checked> Read messages (only to notice replies)</label>' : ''}
<button type="submit">Allow</button><button type="submit" name="deny" value="1">Deny</button></form></body></html>`
  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}
