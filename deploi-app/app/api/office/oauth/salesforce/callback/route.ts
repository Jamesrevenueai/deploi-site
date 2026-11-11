import { NextResponse } from 'next/server'
import { resolveActor } from '@/lib/store/request'
import { completeOfficeConnect, OfficeNotConfigured } from '@/lib/office/connections'
import { isEngineError } from '@/lib/engine/errors'
import { log } from '@/lib/log'
import { hitByIp, tooManyRequests } from '@/lib/security/rate-limit'
import '@/lib/office/actions'

export const dynamic = 'force-dynamic'

/** Salesforce OAuth redirect target (with the PKCE verifier from the stored state). The state must be unused, unexpired and started by this same user in this same organization. */
export async function GET(req: Request) {
  const limited = await hitByIp('oauth_callback', req)
  if (!limited.allowed) return tooManyRequests(limited)
  const url = new URL(req.url)
  const back = (q: string) => NextResponse.redirect(new URL(`/office/connections?${q}`, url.origin), 303)
  try {
    const actor = await resolveActor(req)
    await completeOfficeConnect(actor, { provider: 'salesforce', state: url.searchParams.get('state') ?? '', code: url.searchParams.get('code'), error: url.searchParams.get('error') })
    return back('connected=salesforce')
  } catch (e) {
    if (e instanceof OfficeNotConfigured) return NextResponse.json({ ok: false, error: 'needs_setup', message: e.message }, { status: 503 })
    log.warn('office.oauth.callback_failed', { provider: 'salesforce', code: isEngineError(e) ? e.code : 'error' })
    return back(`error=${encodeURIComponent(isEngineError(e) ? e.message : 'the connection could not be completed')}`)
  }
}
