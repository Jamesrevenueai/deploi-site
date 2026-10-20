/**
 * Client/staff invites. Staff records an invite for an agency; when Supabase Auth is
 * configured the user gets Supabase's magic-link invite email carrying agency_id/role
 * in user metadata, and the profile is created on first sign-in (DB trigger, or the
 * bootstrap in lib/auth.ts). Without a provider the invite is recorded as pending.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from '../env'
import { log } from '../log'
import type { Db } from '../db'
import type { Role } from '../session'

export type InviteRow = {
  id: string
  agency_id: string
  email: string
  role: Role
  invited_by: string | null
  invited_at: string
  accepted_at: string | null
  supabase_user_id: string | null
  status: 'sent' | 'pending (no auth provider)' | 'accepted' | 'revoked'
}

export type InviteResult = { invite: InviteRow; mocked: boolean; emailSent: boolean; supabaseUserId: string | null }

export function hasAuthProvider() {
  return Boolean(env.supabaseUrl && env.supabaseServiceKey)
}

export function adminClient(): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Record an invite and, with a provider, send Supabase's invite email. */
export async function inviteUser(db: Db, opts: { agencyId: string; email: string; role: Role; invitedBy: string | null; provider?: SupabaseClient | null }): Promise<InviteResult> {
  const email = opts.email.trim().toLowerCase()
  if (!EMAIL.test(email)) throw new Error('invalid email')
  if (opts.role !== 'client' && opts.role !== 'staff') throw new Error('invalid role')
  const provider = opts.provider === undefined ? (hasAuthProvider() ? adminClient() : null) : opts.provider
  const status: InviteRow['status'] = provider ? 'sent' : 'pending (no auth provider)'
  const invite = await db.one<InviteRow>(
    `insert into invites (agency_id, email, role, invited_by, status) values ($1, $2, $3, $4, $5)
     on conflict (agency_id, lower(email)) do update set role = excluded.role, invited_by = excluded.invited_by, invited_at = now(), status = excluded.status, accepted_at = null
     returning *`,
    [opts.agencyId, email, opts.role, opts.invitedBy, status])
  if (!invite) throw new Error('invite insert failed')
  if (!provider) {
    log.info('invite.recorded', { inviteId: invite.id, agency_id: opts.agencyId, mocked: true })
    return { invite, mocked: true, emailSent: false, supabaseUserId: null }
  }
  const { data, error } = await provider.auth.admin.inviteUserByEmail(email, {
    data: { agency_id: opts.agencyId, role: opts.role },
    redirectTo: `${env.appUrl}/auth/callback`,
  })
  if (error) {
    log.warn('invite.send_failed', { inviteId: invite.id, code: error.code ?? error.status })
    throw new Error(`invite email failed: ${error.message}`)
  }
  const uid = data.user?.id ?? null
  const updated = await db.one<InviteRow>('update invites set supabase_user_id = $2 where id = $1 returning *', [invite.id, uid])
  log.info('invite.sent', { inviteId: invite.id, agency_id: opts.agencyId })
  return { invite: updated ?? invite, mocked: false, emailSent: true, supabaseUserId: uid }
}

/** Re-send the invite email (no-op without a provider). */
export async function resendInvite(db: Db, inviteId: string, provider?: SupabaseClient | null): Promise<InviteResult> {
  const row = await db.one<InviteRow>('select * from invites where id = $1', [inviteId])
  if (!row) throw new Error('invite not found')
  if (row.accepted_at) throw new Error('already accepted')
  return inviteUser(db, { agencyId: row.agency_id, email: row.email, role: row.role, invitedBy: row.invited_by, provider })
}

/** Revoke an unaccepted invite; with a provider, delete the never-signed-in auth user too. */
export async function revokeInvite(db: Db, inviteId: string, provider?: SupabaseClient | null): Promise<InviteRow> {
  const row = await db.one<InviteRow>('select * from invites where id = $1', [inviteId])
  if (!row) throw new Error('invite not found')
  if (row.accepted_at) throw new Error('already accepted; remove the profile instead')
  const p = provider === undefined ? (hasAuthProvider() ? adminClient() : null) : provider
  if (p && row.supabase_user_id) {
    const { error } = await p.auth.admin.deleteUser(row.supabase_user_id)
    if (error && error.status !== 404) throw new Error(`could not delete auth user: ${error.message}`)
  }
  const updated = await db.one<InviteRow>("update invites set status = 'revoked', supabase_user_id = null where id = $1 returning *", [inviteId])
  log.info('invite.revoked', { inviteId })
  return updated!
}

export async function listAgencyUsers(db: Db, agencyId: string) {
  const profiles = await db.query<{ id: string; email: string; full_name: string | null; role: Role; created_at: string }>(
    'select id, email, full_name, role, created_at from profiles where agency_id = $1 order by email', [agencyId])
  const invites = await db.query<InviteRow>('select * from invites where agency_id = $1 order by invited_at desc', [agencyId])
  return { profiles, invites }
}
