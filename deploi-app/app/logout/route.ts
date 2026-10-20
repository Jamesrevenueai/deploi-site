import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { DEV_COOKIE_NAME } from '@/lib/auth'

export async function POST(req: Request) {
  const store = await cookies()
  store.delete(DEV_COOKIE_NAME)
  if (env.authMode === 'supabase') {
    const { supabaseServer } = await import('@/lib/supabase/server')
    const sb = await supabaseServer()
    await sb.auth.signOut()
  }
  return NextResponse.redirect(new URL('/login', req.url), { status: 303 })
}
