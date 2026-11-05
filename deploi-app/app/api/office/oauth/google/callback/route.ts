import { NextResponse, after } from 'next/server'
import { resolveActor } from '@/lib/store/request'
import { completeOfficeConnect, OfficeNotConfigured } from '@/lib/office/connections'
import { isEngineError } from '@/lib/engine/errors'
import { log } from '@/lib/log'
import { hitByIp, tooManyRequests } from '@/lib/security/rate-limit'
import '@/lib/office/actions'
import { requestDiscovery } from '@/lib/discovery/jobs'

export const dynamic = 'force-dynamic'

/** OAuth redirect target. The state must be unused, unexpired and started by this same user in this same organization. */
export async function GET(req: Request) {
  const limited = await hitByIp('oauth_callback', req)
  if (!limited.allowed) return tooManyRequests(limited)
  const url = new URL(req.url)
  const back = (q: string) => NextResponse.redirect(new URL(`/office/connections?${q}`, url.origin), 303)
  try {
    const actor = await resolveActor(req)
    const conn = await completeOfficeConnect(actor, { provider: 'google_calendar', state: url.searchParams.get('state') ?? '', code: url.searchParams.get('code'), error: url.searchParams.get('error') })
    after(() => requestDiscovery(conn.org_id, `google_calendar:${conn.id}`))
    return back('connected=google_calendar')
  } catch (e) {
    if (e instanceof OfficeNotConfigured) return NextResponse.json({ ok: false, error: 'needs_setup', message: e.message }, { status: 503 })
    log.warn('office.oauth.callback_failed', { provider: 'google_calendar', code: isEngineError(e) ? e.code : 'error' })
    return back(`error=${encodeURIComponent(isEngineError(e) ? e.message : 'the connection could not be completed')}`)
  }
}
