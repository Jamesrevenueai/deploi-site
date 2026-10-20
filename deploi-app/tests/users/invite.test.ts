import './env'
import { describe, it, expect, beforeAll } from 'vitest'
import { prepareDb, AGENCY_A, AGENCY_B, SESSIONS } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { inviteUser, revokeInvite, resendInvite, listAgencyUsers, type InviteRow } from '../../lib/users/invite'
import { uuidFrom } from '../../lib/ids'

const ready = await prepareDb()

/** A stand-in for supabase.auth.admin that records calls instead of emailing. */
function fakeProvider(uid = uuidFrom('fake:auth:' + Date.now())) {
  const calls: { invited: string[]; deleted: string[] } = { invited: [], deleted: [] }
  const provider = { auth: { admin: {
    inviteUserByEmail: async (email: string) => { calls.invited.push(email); return { data: { user: { id: uid } }, error: null } },
    deleteUser: async (id: string) => { calls.deleted.push(id); return { data: {}, error: null } },
  } } }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { provider: provider as any, calls, uid }
}

describe.skipIf(!ready)('invites', () => {
  beforeAll(async () => { await admin(db => db.query("delete from invites where email like 'inv-%@example.com'")) })

  it('records a pending invite when no auth provider is configured', async () => {
    const r = await withUser(SESSIONS.staff, db => inviteUser(db, { agencyId: AGENCY_A, email: 'INV-Pending@example.com', role: 'client', invitedBy: SESSIONS.staff.uid, provider: null }))
    expect(r.mocked).toBe(true)
    expect(r.emailSent).toBe(false)
    expect(r.invite.email).toBe('inv-pending@example.com')
    expect(r.invite.status).toBe('pending (no auth provider)')
  })

  it('sends through the provider with agency/role metadata and stores the auth user id', async () => {
    const f = fakeProvider()
    const r = await withUser(SESSIONS.staff, db => inviteUser(db, { agencyId: AGENCY_A, email: 'inv-sent@example.com', role: 'client', invitedBy: SESSIONS.staff.uid, provider: f.provider }))
    expect(r.mocked).toBe(false)
    expect(r.emailSent).toBe(true)
    expect(f.calls.invited).toEqual(['inv-sent@example.com'])
    expect(r.invite.supabase_user_id).toBe(f.uid)
    expect(r.invite.status).toBe('sent')
  })

  it('is unique per agency + email (case-insensitive) and re-inviting refreshes the row', async () => {
    const first = await withUser(SESSIONS.staff, db => inviteUser(db, { agencyId: AGENCY_A, email: 'inv-dupe@example.com', role: 'client', invitedBy: null, provider: null }))
    const again = await withUser(SESSIONS.staff, db => inviteUser(db, { agencyId: AGENCY_A, email: 'INV-DUPE@example.com', role: 'staff', invitedBy: null, provider: null }))
    expect(again.invite.id).toBe(first.invite.id)
    expect(again.invite.role).toBe('staff')
    const n = await admin(db => db.one<{ n: string }>("select count(*)::text as n from invites where lower(email) = 'inv-dupe@example.com'"))
    expect(Number(n?.n)).toBe(1)
  })

  it('rejects a bad email and a bad role', async () => {
    await expect(withUser(SESSIONS.staff, db => inviteUser(db, { agencyId: AGENCY_A, email: 'nope', role: 'client', invitedBy: null, provider: null }))).rejects.toThrow('invalid email')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(withUser(SESSIONS.staff, db => inviteUser(db, { agencyId: AGENCY_A, email: 'inv-role@example.com', role: 'owner' as any, invitedBy: null, provider: null }))).rejects.toThrow('invalid role')
  })

  it('handle_new_user creates a client profile with the invited agency from auth metadata and marks the invite accepted', async () => {
    const email = 'inv-firstlogin@example.com'
    await withUser(SESSIONS.staff, db => inviteUser(db, { agencyId: AGENCY_B, email, role: 'client', invitedBy: null, provider: null }))
    const uid = uuidFrom('auth:firstlogin')
    await admin(db => db.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3) on conflict (id) do nothing", [uid, email, JSON.stringify({ agency_id: AGENCY_B, role: 'client' })]))
    const p = await admin(db => db.one<{ role: string; agency_id: string }>('select role, agency_id from profiles where id = $1', [uid]))
    expect(p?.role).toBe('client')
    expect(p?.agency_id).toBe(AGENCY_B)
    const inv = await admin(db => db.one<InviteRow>('select * from invites where lower(email) = $1', [email]))
    expect(inv?.status).toBe('accepted')
    expect(inv?.accepted_at).toBeTruthy()
    expect(inv?.supabase_user_id).toBe(uid)
    await admin(db => db.query('delete from auth.users where id = $1', [uid]))
  })

  it('handle_new_user falls back to the invite row when metadata is empty', async () => {
    const email = 'inv-nometa@example.com'
    await withUser(SESSIONS.staff, db => inviteUser(db, { agencyId: AGENCY_A, email, role: 'client', invitedBy: null, provider: null }))
    const uid = uuidFrom('auth:nometa')
    await admin(db => db.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing', [uid, email]))
    const p = await admin(db => db.one<{ role: string; agency_id: string }>('select role, agency_id from profiles where id = $1', [uid]))
    expect(p?.agency_id).toBe(AGENCY_A)
    expect(p?.role).toBe('client')
    await admin(db => db.query('delete from auth.users where id = $1', [uid]))
  })

  it('a staff email always becomes staff even when invited as a client', async () => {
    await admin(db => db.query("select set_config('app.staff_emails', 'inv-staffwins@example.com', false)"))
    const email = 'inv-staffwins@example.com'
    const uid = uuidFrom('auth:staffwins')
    await admin(async db => {
      await db.query("select set_config('app.staff_emails', $1, true)", [email])
      await db.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3) on conflict (id) do nothing', [uid, email, JSON.stringify({ agency_id: AGENCY_A, role: 'client' })])
    })
    const p = await admin(db => db.one<{ role: string }>('select role from profiles where id = $1', [uid]))
    expect(p?.role).toBe('staff')
    await admin(db => db.query('delete from auth.users where id = $1', [uid]))
  })

  it('resend and revoke: revoke deletes the never-signed-in auth user through the provider', async () => {
    const f = fakeProvider()
    const r = await withUser(SESSIONS.staff, db => inviteUser(db, { agencyId: AGENCY_A, email: 'inv-revoke@example.com', role: 'client', invitedBy: null, provider: f.provider }))
    const again = await withUser(SESSIONS.staff, db => resendInvite(db, r.invite.id, f.provider))
    expect(f.calls.invited.length).toBe(2)
    const revoked = await withUser(SESSIONS.staff, db => revokeInvite(db, again.invite.id, f.provider))
    expect(revoked.status).toBe('revoked')
    expect(f.calls.deleted).toEqual([f.uid])
    await expect(withUser(SESSIONS.staff, db => resendInvite(db, revoked.id, f.provider))).resolves.toBeTruthy()
  })

  it('a client user cannot read invites (RLS: staff only)', async () => {
    const rows = await withUser(SESSIONS.clientA, db => db.query('select id from invites'))
    expect(rows.length).toBe(0)
    const list = await withUser(SESSIONS.staff, db => listAgencyUsers(db, AGENCY_A))
    expect(list.invites.length).toBeGreaterThan(0)
    expect(list.profiles.some(p => p.email === 'admin@buckeyehomecare.example')).toBe(true)
  })
})
