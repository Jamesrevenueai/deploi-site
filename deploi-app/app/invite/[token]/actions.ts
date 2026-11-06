'use server'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { env } from '@/lib/env'
import { getSession, encodeDevSession, DEV_COOKIE_NAME, DEV_SESSION_TTL_S } from '@/lib/auth'
import { log } from '@/lib/log'
import { hit, ipKey } from '@/lib/security/rate-limit'
import { acceptInvite, inviteInfo, InviteError, parseInviteToken } from '@/lib/platform/invites'
import { devAccountFor } from '@/lib/platform/dev-accounts'

const back = (token: string, q: string) => `/invite/${token}?${q}`
const tokenOf = (fd: FormData) => { const t = String(fd.get('token') ?? ''); return parseInviteToken(t) ? t : null }

/** Join the organization: the invite is consumed by server code for the signed-in person (lib/platform/invites.ts). */
export async function acceptInviteAction(fd: FormData) {
  const token = tokenOf(fd)
  if (!token) redirect('/login?error=invitation-link-not-valid')
  const s = await getSession()
  if (!s) redirect(back(token, 'error=sign-in-first'))
  try {
    const r = await acceptInvite(s, token)
    log.info('invite.accepted', { org: r.orgId, role: r.role, app_metadata: r.appMetadata })
  } catch (e) {
    if (e instanceof InviteError) redirect(back(token, `refused=${e.reason}`))
    throw e
  }
  redirect('/store')
}

/** Production: email a Supabase sign-in link to the invited address; it returns to this page. */
export async function inviteMagicLink(fd: FormData) {
  const token = tokenOf(fd)
  if (!token) redirect('/login?error=invitation-link-not-valid')
  const info = await inviteInfo(token)
  if (info.state !== 'valid') redirect(back(token, `refused=${info.state}`))
  const h = await headers()
  if (!(await hit('magic_link_ip', ipKey(h))).allowed || !(await hit('magic_link_email', `email:${info.email.slice(0, 190)}`)).allowed) redirect(back(token, 'error=too-many-attempts'))
  const { supabaseServer } = await import('@/lib/supabase/server')
  const sb = await supabaseServer()
  // the address is the invited one from the invite row, never one typed into the form
  const { error } = await sb.auth.signInWithOtp({ email: info.email, options: { emailRedirectTo: `${env.appUrl}/auth/callback?next=${encodeURIComponent(`/invite/${token}`)}` } })
  if (error) { log.warn('invite.magiclink.failed', { code: error.code }); redirect(back(token, 'error=send-failed')) }
  redirect(back(token, 'sent=1'))
}

/** Development only (dev auth, never production): sign in as the invited address, creating that account if it is new. */
export async function inviteDevSignIn(fd: FormData) {
  const token = tokenOf(fd)
  if (!token) redirect('/login?error=invitation-link-not-valid')
  if (env.authMode !== 'dev') redirect(back(token, 'error=dev-auth-disabled'))
  if (!(await hit('dev_login', ipKey(await headers()))).allowed) redirect(back(token, 'error=too-many-attempts'))
  const info = await inviteInfo(token)
  if (info.state !== 'valid') redirect(back(token, `refused=${info.state}`))
  const p = await devAccountFor(info.email)
  const store = await cookies()
  store.set(DEV_COOKIE_NAME, encodeDevSession({ uid: p.id, email: p.email, role: p.role, agencyId: p.agency_id }), { httpOnly: true, sameSite: 'lax', secure: env.isProd, path: '/', maxAge: DEV_SESSION_TTL_S })
  redirect(`/invite/${token}`)
}
