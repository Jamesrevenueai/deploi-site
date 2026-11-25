import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { hitByIp, tooManyRequests } from '@/lib/security/rate-limit'
import { safeNextPath } from '@/lib/safe-next'

/**
 * Supabase magic-link landing: exchange the code for a session cookie. Limited per client IP (bucket auth_callback).
 * `next` returns to an invitation (/invite/<token>) or the first run (/start); any other value is ignored.
 */
export async function GET(req: Request) {
  const limited = await hitByIp('auth_callback', req)
  if (!limited.allowed) return tooManyRequests(limited)
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const next = safeNextPath(url.searchParams.get('next'))
  if (code && env.authMode === 'supabase') {
    const { supabaseServer } = await import('@/lib/supabase/server')
    const sb = await supabaseServer()
    const { error } = await sb.auth.exchangeCodeForSession(code)
    if (error) return NextResponse.redirect(new URL(next ? `${next}?error=link-expired` : '/login?error=link-expired', req.url))
  }
  return NextResponse.redirect(new URL(next ?? '/', req.url))
}
