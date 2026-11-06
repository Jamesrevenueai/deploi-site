/**
 * A crew member's "Mark done" button (the form on /crew/done/<token>). The token is signed, single-use and
 * expiring (lib/notify/crew.ts): the first valid POST marks the job done and emits one crew.done event; any
 * later POST changes nothing. No sign-in; limited per client IP (bucket crew_done). GET does nothing.
 */
import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { log } from '@/lib/log'
import { completeCrewLink, CREW_DONE_PATH } from '@/lib/notify/crew'
import { hitByIp, tooManyRequests } from '@/lib/security/rate-limit'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const limited = await hitByIp('crew_done', req)
  if (!limited.allowed) return tooManyRequests(limited)
  let t = ''
  const type = req.headers.get('content-type') ?? ''
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const f = await req.formData().catch(() => null)
    const v = f?.get('t')
    if (typeof v === 'string') t = v
  } else {
    const j = (await req.json().catch(() => ({}))) as { t?: unknown }
    if (typeof j.t === 'string') t = j.t
  }
  if (!t || t.length > 400) return NextResponse.json({ ok: false, error: 'invalid_token' }, { status: 400 })
  try {
    const r = await completeCrewLink(t)
    if (r.state === 'invalid') return NextResponse.json({ ok: false, error: 'invalid_token' }, { status: 400 })
    if (!type.includes('form')) return NextResponse.json({ ok: r.state === 'ready', state: r.state })
    const back = `${env.appUrl.replace(/\/$/, '')}${CREW_DONE_PATH}${encodeURIComponent(t)}${r.state === 'ready' ? '?r=done' : ''}`
    return NextResponse.redirect(back, 303)
  } catch (e) {
    log.warn('crew.done.failed', { reason: (e as Error).message.slice(0, 120) })
    return NextResponse.json({ ok: false, error: 'failed' }, { status: 500 })
  }
}
