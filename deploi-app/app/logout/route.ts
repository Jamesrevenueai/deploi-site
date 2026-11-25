import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { DEV_COOKIE_NAME } from '@/lib/auth'
import { safeNextPath } from '@/lib/safe-next'

export async function POST(req: Request) {
  const store = await cookies()
  store.delete(DEV_COOKIE_NAME)
  if (env.authMode === 'supabase') {
    const { supabaseServer } = await import('@/lib/supabase/server')
    const sb = await supabaseServer()
    await sb.auth.signOut()
  }
  // an invitation page signs out to come back to itself (only /invite/<token> or /start are accepted)
  const form = await req.formData().catch(() => null)
  return NextResponse.redirect(new URL(safeNextPath(form?.get('next')) ?? '/login', req.url), { status: 303 })
}
