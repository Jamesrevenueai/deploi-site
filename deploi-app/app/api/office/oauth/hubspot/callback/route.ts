import { NextResponse } from 'next/server'
import { resolveActor } from '@/lib/store/request'
import { completeOfficeConnect, OfficeNotConfigured } from '@/lib/office/connections'
import { isEngineError } from '@/lib/engine/errors'
import { log } from '@/lib/log'
import '@/lib/office/actions'

export const dynamic = 'force-dynamic'

/** OAuth redirect target. The state must be unused, unexpired and started by this same user in this same organization. */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const back = (q: string) => NextResponse.redirect(new URL(`/office/connections?${q}`, url.origin), 303)
  try {
    const actor = await resolveActor(req)
    await completeOfficeConnect(actor, { provider: 'hubspot', state: url.searchParams.get('state') ?? '', code: url.searchParams.get('code'), error: url.searchParams.get('error') })
    return back('connected=hubspot')
  } catch (e) {
    if (e instanceof OfficeNotConfigured) return NextResponse.json({ ok: false, error: 'needs_setup', message: e.message }, { status: 503 })
    log.warn('office.oauth.callback_failed', { provider: 'hubspot', code: isEngineError(e) ? e.code : 'error' })
    return back(`error=${encodeURIComponent(isEngineError(e) ? e.message : 'the connection could not be completed')}`)
  }
}
