/**
 * Session resolution for both auth modes.
 *  - supabase: magic link via @supabase/ssr; profile looked up by auth uid.
 *  - dev: signed cookie naming a seeded profile (local/preview only).
 */
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from './env'
import { isProductionDeployment } from './auth-guard'
import { admin } from './db'
import { homeFor, type Session, type Role } from './session'

const DEV_COOKIE = 'deploi_dev_session'

/** Dev sessions last at most this long, whatever the cookie's own max-age says. */
export const DEV_SESSION_TTL_S = 60 * 60 * 24 * 7
/** A signing secret shorter than this (or unset) disables dev sessions entirely: nothing is signed or accepted. */
export const MIN_APP_SECRET_LENGTH = 32

function secret(): string | null {
  const k = env.appSecret
  return k.length >= MIN_APP_SECRET_LENGTH ? k : null
}
function sign(payload: string, key: string) {
  return createHmac('sha256', key).update(payload).digest('base64url')
}
export function encodeDevSession(s: Session, now = Date.now()) {
  const key = secret()
  if (!key) throw new Error(`APP_SECRET must be set to at least ${MIN_APP_SECRET_LENGTH} characters to sign dev sessions`)
  const iat = Math.floor(now / 1000)
  const p = Buffer.from(JSON.stringify({ ...s, iat, exp: iat + DEV_SESSION_TTL_S })).toString('base64url')
  return `${p}.${sign(p, key)}`
}
/**
 * A dev cookie is a session only when: not production, APP_SECRET is strong, the signature matches,
 * and it has not expired. Rotating APP_SECRET invalidates every dev cookie signed with the old one.
 * Cookies issued before expiry was added (no exp) are rejected.
 */
export function decodeDevSession(v: string | undefined, now = Date.now()): Session | null {
  // a dev cookie is never a session in production, even one signed with the right secret
  if (!v || isProductionDeployment()) return null
  const key = secret()
  if (!key) return null
  const [p, sig] = v.split('.')
  if (!p || !sig) return null
  const want = sign(p, key)
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null
  try {
    const { iat, exp, ...s } = JSON.parse(Buffer.from(p, 'base64url').toString()) as Session & { iat?: number; exp?: number }
    if (typeof exp !== 'number' || typeof iat !== 'number' || exp - iat > DEV_SESSION_TTL_S || now / 1000 >= exp) return null
    return s as Session
  } catch { return null }
}

export async function profileFor(uid: string): Promise<Session | null> {
  return admin(async db => {
    const p = await db.one<{ id: string; email: string; role: Role; agency_id: string | null; full_name: string | null; org_type: string | null }>(
      'select p.id, p.email, p.role, p.agency_id, p.full_name, g.org_type from profiles p left join agencies g on g.id = p.agency_id where p.id = $1', [uid])
    if (!p) return null
    return { uid: p.id, email: p.email, role: p.role, agencyId: p.agency_id, fullName: p.full_name, orgType: p.org_type }
  })
}

export async function getSession(): Promise<Session | null> {
  const store = await cookies()
  if (env.authMode === 'dev') {
    const s = decodeDevSession(store.get(DEV_COOKIE)?.value)
    if (!s) return null
    // re-read the profile so role/agency changes take effect immediately
    return (await profileFor(s.uid)) ?? null
  }
  const { supabaseServer } = await import('./supabase/server')
  const sb = await supabaseServer()
  const { data } = await sb.auth.getUser()
  if (!data.user) return null
  let s = await profileFor(data.user.id)
  if (!s && data.user.email) {
    // profile trigger did not run (e.g. user predates migration): create it from the
    // invite metadata (agency_id / role), falling back to staff-by-email or a client with no agency.
    const meta = (data.user.user_metadata ?? {}) as { agency_id?: string; role?: string }
    const isStaff = env.staffEmails.includes(data.user.email.toLowerCase())
    const role: Role = isStaff ? 'staff' : meta.role === 'staff' || meta.role === 'client' ? meta.role : 'client'
    const agencyId = /^[0-9a-f-]{36}$/i.test(meta.agency_id ?? '') ? meta.agency_id! : null
    await admin(async db => {
      await db.query('insert into profiles (id, email, role, agency_id) values ($1,$2,$3,$4) on conflict (id) do nothing', [data.user!.id, data.user!.email, role, agencyId])
      await db.query("update invites set accepted_at = now(), status = 'accepted', supabase_user_id = $2 where lower(email) = lower($1) and accepted_at is null and status <> 'revoked'", [data.user!.email, data.user!.id])
    })
    s = await profileFor(data.user.id)
  }
  return s
}

export async function requireSession(): Promise<Session> {
  const s = await getSession()
  if (!s) redirect('/login')
  return s
}

export async function requireRole(role: Role): Promise<Session> {
  const s = await requireSession()
  if (s.role !== role) redirect(homeFor(s))
  return s
}

export async function requestIp(): Promise<string | null> {
  const h = await headers()
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || null
}

export const DEV_COOKIE_NAME = DEV_COOKIE
