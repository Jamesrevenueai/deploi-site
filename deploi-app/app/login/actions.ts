'use server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { encodeDevSession, DEV_COOKIE_NAME, DEV_SESSION_TTL_S } from '@/lib/auth'
import { log } from '@/lib/log'
import { homeFor, type Role } from '@/lib/session'

export async function devSignIn(formData: FormData) {
  if (env.authMode !== 'dev') redirect('/login?error=dev-auth-disabled')
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const p = await admin(db => db.one<{ id: string; email: string; role: Role; agency_id: string | null; org_type: string | null }>(
    'select p.id, p.email, p.role, p.agency_id, g.org_type from profiles p left join agencies g on g.id = p.agency_id where lower(p.email) = $1', [email]))
  if (!p) redirect('/login?error=unknown-user')
  const store = await cookies()
  store.set(DEV_COOKIE_NAME, encodeDevSession({ uid: p.id, email: p.email, role: p.role, agencyId: p.agency_id }), {
    httpOnly: true, sameSite: 'lax', secure: env.isProd, path: '/', maxAge: DEV_SESSION_TTL_S,
  })
  log.info('auth.dev.signin', { uid: p.id, role: p.role })
  redirect(homeFor({ role: p.role, orgType: p.org_type }))
}

export async function magicLink(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  if (!email) redirect('/login?error=email-required')
  const { supabaseServer } = await import('@/lib/supabase/server')
  const sb = await supabaseServer()
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: `${env.appUrl}/auth/callback` } })
  if (error) { log.warn('auth.magiclink.failed', { code: error.code }); redirect('/login?error=send-failed') }
  redirect('/login?sent=1')
}
