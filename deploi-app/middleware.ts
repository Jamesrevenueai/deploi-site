import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { env } from './lib/env'

/** Keeps Supabase auth cookies fresh. Authorization itself happens in the layouts (requireRole). */
export async function middleware(req: NextRequest) {
  const url = env.supabaseUrl
  const key = env.supabaseAnonKey
  if (!url || !key || env.authMode === 'dev') return NextResponse.next()
  let res = NextResponse.next({ request: req })
  const sb = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: all => {
        all.forEach(({ name, value }) => req.cookies.set(name, value))
        res = NextResponse.next({ request: req })
        all.forEach(({ name, value, options }) => res.cookies.set(name, value, options))
      },
    },
  })
  await sb.auth.getUser()
  return res
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api/public|api/webhooks|api/cron).*)'] }
