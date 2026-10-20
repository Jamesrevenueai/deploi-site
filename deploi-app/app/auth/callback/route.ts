import { NextResponse } from 'next/server'
import { env } from '@/lib/env'

/** Supabase magic-link landing: exchange the code for a session cookie. */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  if (code && env.authMode === 'supabase') {
    const { supabaseServer } = await import('@/lib/supabase/server')
    const sb = await supabaseServer()
    const { error } = await sb.auth.exchangeCodeForSession(code)
    if (error) return NextResponse.redirect(new URL('/login?error=link-expired', req.url))
  }
  return NextResponse.redirect(new URL('/', req.url))
}
