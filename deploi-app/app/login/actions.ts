'use server'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { env } from '@/lib/env'
import { admin } from '@/lib/db'
import { encodeDevSession, DEV_COOKIE_NAME, DEV_SESSION_TTL_S } from '@/lib/auth'
import { log } from '@/lib/log'
import { homeFor, type Role } from '@/lib/session'
import { hit, ipKey } from '@/lib/security/rate-limit'
import { safeNextPath } from '@/lib/safe-next'
import { devAccountFor } from '@/lib/platform/dev-accounts'

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
  redirect(safeNext(formData.get('next')) ?? homeFor({ role: p.role, orgType: p.org_type, agencyId: p.agency_id }))
}

const safeNext = safeNextPath

const NEW_EMAIL = /^[^\s@<>(),;:"[\]\\]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i

/**
 * Development only (AUTH_MODE=dev, never production): create a new account with no organization, as Supabase
 * sign-up would, and sign in. The profile comes from the same sign-up trigger; nothing here assigns a role or
 * an organization (the first run at /start creates one; an invitation link joins one).
 */
export async function devSignUp(formData: FormData) {
  if (env.authMode !== 'dev') redirect('/login?error=dev-auth-disabled')
  if (await limited('dev_login')) redirect('/login?error=too-many-attempts')
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  if (!NEW_EMAIL.test(email) || email.length > 254) redirect('/login?error=enter-a-valid-email')
  const p = await devAccountFor(email)
  const store = await cookies()
  store.set(DEV_COOKIE_NAME, encodeDevSession({ uid: p.id, email: p.email, role: p.role, agencyId: p.agency_id }), {
    httpOnly: true, sameSite: 'lax', secure: env.isProd, path: '/', maxAge: DEV_SESSION_TTL_S,
  })
  log.info('auth.dev.signup', { uid: p.id, created: p.created })
  redirect(safeNext(formData.get('next')) ?? homeFor({ role: p.role, orgType: p.org_type, agencyId: p.agency_id }))
}

export async function magicLink(formData: FormData) {
  if (await limited('magic_link_ip')) redirect('/login?error=too-many-attempts')
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  if (!email) redirect('/login?error=email-required')
  if (await limited('magic_link_email', `email:${email.slice(0, 190)}`)) redirect('/login?error=too-many-attempts')
  const { supabaseServer } = await import('@/lib/supabase/server')
  const sb = await supabaseServer()
  const next = safeNext(formData.get('next'))
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: `${env.appUrl}/auth/callback${next ? `?next=${encodeURIComponent(next)}` : ''}` } })
  if (error) { log.warn('auth.magiclink.failed', { code: error.code }); redirect(next ? `${next}?error=send-failed` : '/login?error=send-failed') }
  redirect(next ? `${next}?sent=1` : '/login?sent=1')
}
