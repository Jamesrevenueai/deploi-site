'use server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { encodeDevSession, DEV_COOKIE_NAME } from '@/lib/auth'
import { log } from '@/lib/log'
import type { Role } from '@/lib/session'

export async function devSignIn(formData: FormData) {
  if (env.authMode !== 'dev') redirect('/login?error=dev-auth-disabled')
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const p = await admin(db => db.one<{ id: string; email: string; role: Role; agency_id: string | null }>(
    'select id, email, role, agency_id from profiles where lower(email) = $1', [email]))
  if (!p) redirect('/login?error=unknown-user')
  const store = await cookies()
  store.set(DEV_COOKIE_NAME, encodeDevSession({ uid: p.id, email: p.email, role: p.role, agencyId: p.agency_id }), {
    httpOnly: true, sameSite: 'lax', secure: env.isProd, path: '/', maxAge: 60 * 60 * 24 * 7,
  })
  log.info('auth.dev.signin', { uid: p.id, role: p.role })
  redirect(p.role === 'staff' ? '/staff/pipeline' : '/app/home')
}

/**
 * Invite-only magic link. Only people who already have a Supabase user (invited from
 * /staff/agencies/[id]/users) or who are listed in STAFF_EMAILS can get a link; everyone
 * else is pointed at /signup. The response does not reveal whether an email has access.
 */
export async function magicLink(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  if (!email) redirect('/login?error=email-required')
  if (env.authMode !== 'supabase' || !env.authReady) redirect('/login?error=sign-in-not-configured')
  const { supabaseServer } = await import('@/lib/supabase/server')
  const sb = await supabaseServer()
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${env.appUrl}/auth/callback`, shouldCreateUser: env.staffEmails.includes(email) },
  })
  if (error) log.warn('auth.magiclink.failed', { code: error.code })
  redirect('/login?sent=1')
}
