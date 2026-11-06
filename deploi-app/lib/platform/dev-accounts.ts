/**
 * Development sign-up (AUTH_MODE=dev only; dev auth never runs in production, lib/auth-guard.ts). Creates the
 * auth user exactly as Supabase sign-up would, so the profile comes from the same sign-up trigger: a client with
 * no organization. Nothing here assigns a role or an organization.
 */
import { admin } from '../db'
import { env } from '../env'
import type { Role } from '../session'

export async function devAccountFor(email: string) {
  if (env.authMode !== 'dev') throw new Error('development accounts exist only with dev auth')
  return admin(async db => {
    const find = () => db.one<{ id: string; email: string; role: Role; agency_id: string | null; org_type: string | null }>(
      'select p.id, p.email, p.role, p.agency_id, g.org_type from profiles p left join agencies g on g.id = p.agency_id where lower(p.email) = $1', [email])
    const found = await find()
    if (found) return { ...found, created: false }
    await db.query('insert into auth.users (id, email) values (gen_random_uuid(), $1)', [email])
    const made = await find()
    if (!made) throw new Error('the sign-up trigger did not create a profile')
    return { ...made, created: true }
  })
}
