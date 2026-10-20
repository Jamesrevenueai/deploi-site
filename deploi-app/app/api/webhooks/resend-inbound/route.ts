/** Resend inbound email → referrals row (source_channel email). Verified with the svix headers when RESEND_WEBHOOK_SECRET is set. */
import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { log } from '@/lib/log'
import { verifySvix } from '@/lib/workers/webhooks'

function parseFrom(from: string) {
  const m = from.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/)
  return m ? { name: m[1].trim() || null, email: m[2].trim() } : { name: null, email: from.trim() }
}
function guess(text: string, re: RegExp) { const m = text.match(re); return m ? m[1].trim() : null }

export async function POST(req: Request) {
  const raw = await req.text()
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim()
  if (secret && !verifySvix(secret, req.headers.get('svix-id'), req.headers.get('svix-timestamp'), req.headers.get('svix-signature'), raw)) {
    return NextResponse.json({ ok: false }, { status: 403 })
  }
  let evt: { type?: string; data?: Record<string, unknown> }
  try { evt = JSON.parse(raw) } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }) }
  if (evt.type && !/received|inbound/.test(evt.type)) return NextResponse.json({ ok: true, ignored: evt.type })
  const d = evt.data ?? {}
  const from = parseFrom(String(d.from ?? ''))
  const to = ([] as string[]).concat((d.to as string[] | string) ?? [])
  const subject = String(d.subject ?? '')
  const text = String(d.text ?? d.html ?? '')
  // Route by the inbound address slug: referrals+<agency-id>@... or the first agency when unset.
  const slug = to.map(t => t.match(/\+([0-9a-f-]{36})@/)?.[1]).find(Boolean)
  const id = await admin(async db => {
    const agency = slug ? await db.one<{ id: string }>('select id from agencies where id = $1', [slug]) : await db.one<{ id: string }>('select id from agencies order by created_at limit 1')
    if (!agency) return null
    const r = await db.one<{ id: string }>(
      `insert into referrals (agency_id, source_name, source_org, source_channel, source_email, client_name, county, service, received_at, status, notes)
       values ($1,$2,$3,'email',$4,$5,$6,$7,now(),'new',$8) returning id`,
      [agency.id, from.name, guess(text, /(?:organization|agency|from)\s*:\s*(.+)/i) ?? from.email.split('@')[1] ?? null, from.email,
       guess(text, /(?:client|patient|consumer)\s*(?:name)?\s*:\s*(.+)/i), guess(text, /county\s*:\s*(.+)/i), guess(text, /service\s*(?:code)?\s*:\s*([A-Z0-9]+)/i),
       `Subject: ${subject}\n\n${text.slice(0, 4000)}`])
    return r?.id ?? null
  })
  log.info('resend.inbound.referral', { referral_id: id })
  return NextResponse.json({ ok: true, id })
}
