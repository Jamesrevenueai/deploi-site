'use server'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { encodeDevSession, DEV_COOKIE_NAME, DEV_SESSION_TTL_S } from '@/lib/auth'
import { log } from '@/lib/log'
import { homeFor, type Role } from '@/lib/session'
import { hit, ipKey } from '@/lib/security/rate-limit'

/** Sign-in attempts are limited per client IP (and sign-in links also per address); refused attempts land back on /login. */
async function limited(bucket: 'dev_login' | 'magic_link_ip' | 'magic_link_email', key?: string): Promise<boolean> {
  return !(await hit(bucket, key ?? ipKey(await headers()))).allowed
}

export async function devSignIn(formData: FormData) {
  if (env.authMode !== 'dev') redirect('/login?error=dev-auth-disabled')
  if (await limited('dev_login')) redirect('/login?error=too-many-attempts')
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
  if (await limited('magic_link_ip')) redirect('/login?error=too-many-attempts')
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  if (!email) redirect('/login?error=email-required')
  if (await limited('magic_link_email', `email:${email.slice(0, 190)}`)) redirect('/login?error=too-many-attempts')
  const { supabaseServer } = await import('@/lib/supabase/server')
  const sb = await supabaseServer()
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: `${env.appUrl}/auth/callback` } })
  if (error) { log.warn('auth.magiclink.failed', { code: error.code }); redirect('/login?error=send-failed') }
  redirect('/login?sent=1')
}
