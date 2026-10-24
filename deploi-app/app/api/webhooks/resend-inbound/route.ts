/**
 * Resend webhooks. Inbound email (email.received) -> referrals row (source_channel email); a reply from a
 * known referrer ("Re:" + same sender) retires the drafted first reply and files an admin task instead of a
 * duplicate referral. Delivery events (email.delivered / email.bounced / email.complained) -> delivery_status.
 * Fails closed in production when RESEND_WEBHOOK_SECRET is missing (503); svix-verified whenever it is set.
 */
import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { log } from '@/lib/log'
import { verifySvix } from '@/lib/workers/webhooks'
import { webhookSecretGuard, guardResponse } from '@/lib/workers/webhook-guard'
import { opsConfig } from '@/lib/workers/config'
import { insertProposal, recordDeliveryCallback } from '@/lib/workers/runtime'
import { suppressReferralFollowups } from '@/lib/workers/suppress'
import { assertBaaSigned, baaResponse, isBaaError } from '@/lib/baa/gate'

function parseFrom(from: string) {
  const m = from.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/)
  return m ? { name: m[1].trim() || null, email: m[2].trim() } : { name: null, email: from.trim() }
}
function guess(text: string, re: RegExp) { const m = text.match(re); return m ? m[1].trim() : null }

export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim()
  const refused = guardResponse('resend', webhookSecretGuard('resend', secret, opsConfig.isProd))
  if (refused) return refused
  const raw = await req.text()
  if (secret && !verifySvix(secret, req.headers.get('svix-id'), req.headers.get('svix-timestamp'), req.headers.get('svix-signature'), raw)) {
    return NextResponse.json({ ok: false }, { status: 403 })
  }
  let evt: { type?: string; data?: Record<string, unknown> }
  try { evt = JSON.parse(raw) } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }) }
  const d = evt.data ?? {}

  // Delivery events for mail we sent: provider acceptance becomes delivered / failed here and nowhere else.
  if (evt.type && /^email\.(delivered|bounced|complained|delivery_delayed)$/.test(evt.type)) {
    const emailId = String(d.email_id ?? d.id ?? '')
    if (!emailId) return NextResponse.json({ ok: true, ignored: 'no email_id' })
    if (evt.type === 'email.delivery_delayed') return NextResponse.json({ ok: true, ignored: evt.type })
    const outcome = evt.type === 'email.delivered' ? 'delivered' : 'bounced'
    const bounce = d.bounce as { message?: string; type?: string } | undefined
    const matched = await admin(db => recordDeliveryCallback(db, emailId, outcome, bounce?.message ?? bounce?.type ?? evt.type))
    return NextResponse.json({ ok: true, matched, type: evt.type })
  }
  if (evt.type && !/received|inbound/.test(evt.type)) return NextResponse.json({ ok: true, ignored: evt.type })

  const from = parseFrom(String(d.from ?? ''))
  const to = ([] as string[]).concat((d.to as string[] | string) ?? [])
  const subject = String(d.subject ?? '')
  const text = String(d.text ?? d.html ?? '')
  // Route by the inbound address slug: referrals+<agency-id>@... or the first agency when unset.
  const slug = to.map(t => t.match(/\+([0-9a-f-]{36})@/)?.[1]).find(Boolean)
  let id: string | null = null
  let replied = false
  try {
    id = await admin(async db => {
      const agency = slug ? await db.one<{ id: string; name: string }>('select id, name from agencies where id = $1', [slug]) : await db.one<{ id: string; name: string }>('select id, name from agencies order by created_at limit 1')
      if (!agency) return null
      await assertBaaSigned(db, agency.id)
      // A reply from a referrer we already have on file: stop the drafted first reply, hand the thread to a person.
      if (/^\s*re\s*:/i.test(subject) && from.email) {
        const existing = await db.one<{ id: string; source_org: string | null }>(
          "select id, source_org from referrals where agency_id = $1 and lower(source_email) = lower($2) order by received_at desc limit 1", [agency.id, from.email])
        if (existing) {
          replied = true
          await suppressReferralFollowups(db, agency.id, existing.id, 'referrer_replied')
          await insertProposal(db, agency, 'inbound_triage', {
            kind: 'task', to_ref: 'admin', subject: `Referrer replied: ${subject.slice(0, 80)}`,
            body: `The referral source (${existing.source_org ?? 'known referrer'}) replied by email. Read and answer it from the office inbox:\n\n${text.slice(0, 1500)}`,
            payload: { to_label: 'Admin', referral_id: existing.id, reason: 'referrer_replied' },
            dedupe_key: `ref:${existing.id}:reply-in:${new Date().toISOString().slice(0, 13)}`,
          })
          return existing.id
        }
      }
      const r = await db.one<{ id: string }>(
        `insert into referrals (agency_id, source_name, source_org, source_channel, source_email, client_name, county, service, received_at, status, notes)
         values ($1,$2,$3,'email',$4,$5,$6,$7,now(),'new',$8) returning id`,
        [agency.id, from.name, guess(text, /(?:organization|agency|from)\s*:\s*(.+)/i) ?? from.email.split('@')[1] ?? null, from.email,
         guess(text, /(?:client|patient|consumer)\s*(?:name)?\s*:\s*(.+)/i), guess(text, /county\s*:\s*(.+)/i), guess(text, /service\s*(?:code)?\s*:\s*([A-Z0-9]+)/i),
         `Subject: ${subject}\n\n${text.slice(0, 4000)}`])
      return r?.id ?? null
    })
  } catch (e) {
    if (isBaaError(e)) return baaResponse(e)
    throw e
  }
  log.info(replied ? 'resend.inbound.referrer_reply' : 'resend.inbound.referral', { referral_id: id })
  return NextResponse.json({ ok: true, id, replied })
}
