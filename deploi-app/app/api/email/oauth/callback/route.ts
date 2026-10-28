import { NextResponse } from 'next/server'
import { resolveActor, HttpError } from '@/lib/store/request'
import { completeConnect } from '@/lib/email/accounts'
import { isEngineError } from '@/lib/engine/errors'
import { log } from '@/lib/log'

export const dynamic = 'force-dynamic'

/**
 * Provider redirect target. With a Deploi session cookie the connection completes here (state must be
 * unused, unexpired, and started by this same user in this same organization). Without one (the
 * embedded Shopify app opens consent in a separate window) the state and code are handed back to the
 * window that started it, which completes with its own verified session token.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const state = url.searchParams.get('state') ?? ''
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')
  const back = (path: string) => NextResponse.redirect(new URL(path, url.origin), 303)
  let actor
  try { actor = await resolveActor(req) } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      const q = new URLSearchParams({ state, ...(code ? { code } : {}), ...(error ? { error } : {}) })
      return back(`/email/oauth-return?${q}`)
    }
    return back('/store/connections?email=error')
  }
  try {
    const r = await completeConnect(actor, { state, code, error })
    return back(`${r.returnTo ?? '/store/connections'}?email=connected`)
  } catch (e) {
    const reason = isEngineError(e) ? e.code : 'failed'
    log.warn('email.oauth.callback_failed', { reason })
    return back(`/store/connections?email=${encodeURIComponent(reason)}`)
  }
}
