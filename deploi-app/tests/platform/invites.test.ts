/**
 * Member invitations end to end in server code (lib/platform/invites.ts): the invitation email's exact content,
 * the signed link (forged, tampered, expired, reused, replaced, revoked, wrong address, another organization's),
 * the role on acceptance with user_metadata claims ignored, app_metadata recorded with the service role when
 * Supabase is configured, and the last-owner protection.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { NW, HB, merchantActor, staffActor } from '../merchant/helpers'
import { setEmailFetch } from '../../lib/email/adapters/http'
import { setSupabaseAdminFetch } from '../../lib/supabase/admin-api'
import { inviteMember, resendInvite, revokeInvite, acceptInvite, inviteInfo, parseInviteToken, makeInviteToken, INVITE_TTL_MS } from '../../lib/platform/invites'
import { changeRole, listMembers, removeMember } from '../../lib/platform/members'
import { person, removePeople } from './helpers'
import type { Session } from '../../lib/session'

const ready = await prepareDb()
const sent: { body: Record<string, unknown> }[] = []
const DOMAIN = '@invite-test.example'
const made: string[] = []

/** A brand-new sign-up exactly as Supabase would insert it, with whatever user metadata the person chose. */
async function signUp(email: string, userMeta: Record<string, unknown> = {}): Promise<Session> {
  const id = await admin(async db => (await db.one<{ id: string }>(`insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), $1, $2) returning id`, [email, JSON.stringify(userMeta)]))!.id)
  made.push(id)
  const p = (await admin(db => db.one<{ agency_id: string | null; role: 'client' | 'staff' }>('select agency_id, role from profiles where id = $1', [id])))!
  return { uid: id, email, role: p.role, agencyId: p.agency_id }
}
const profile = (uid: string) => admin(db => db.one<{ agency_id: string | null; org_role: string | null }>('select agency_id, org_role from profiles where id = $1', [uid]))
const tokenFrom = (link: string) => link.split('/invite/')[1]
const addr = (tag: string) => `${tag}.${Date.now()}.${Math.random().toString(16).slice(2, 6)}${DOMAIN}`

async function cleanup() {
  await admin(async db => {
    await db.query(`delete from invites where email like $1`, [`%${DOMAIN}`])
    await db.query(`delete from system_emails where to_address like $1`, [`%${DOMAIN}`])
    if (made.length) { await db.query('delete from profiles where id = any($1)', [made]); await db.query('delete from auth.users where id = any($1)', [made]) }
  })
  made.length = 0
}

describe.skipIf(!ready)('member invitations', () => {
  beforeEach(async () => {
    sent.length = 0
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.EMAIL_LIVE_SENDS = 'allowlist'
    process.env.EMAIL_TEST_RECIPIENTS = DOMAIN
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.deploi.test'
    setEmailFetch(async (url, init) => {
      if (!url.endsWith('/emails')) throw new Error(`unexpected HTTP call in test: ${url}`)
      sent.push({ body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 })
    })
  })
  afterEach(async () => {
    setEmailFetch(null); setSupabaseAdminFetch(null)
    for (const k of ['RESEND_API_KEY', 'EMAIL_LIVE_SENDS', 'EMAIL_TEST_RECIPIENTS', 'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) delete process.env[k]
    await cleanup()
  })
  afterAll(async () => { if (ready) await removePeople(NW) })

  it('an owner invites by email with a role: a signed 7-day link, recorded, and this exact email', async () => {
    const owner = await merchantActor(NW)
    const email = addr('pat')
    const r = await inviteMember(owner, email.toUpperCase(), 'admin')
    expect(r).toMatchObject({ email, role: 'admin', emailStatus: 'sent' })
    expect(r.link).toBeUndefined() // sent: the link is only in the email
    expect(sent).toHaveLength(1)
    const m = sent[0].body
    const org = (await admin(db => db.one<{ name: string }>('select name from agencies where id = $1', [NW.org])))!.name
    const link = String(m.text).match(/https:\/\/app\.deploi\.test\/invite\/\S+/)![0]
    const expires = new Date(Date.parse(r.expiresAt)).toISOString().slice(0, 10)
    expect(m.from).toBe('Deploi <support@getdeploi.com>')
    expect(m.to).toEqual([email])
    expect(m.subject).toBe(`${NW.email} invited you to ${org} on Deploi`)
    expect(m.text).toBe([
      `${NW.email} invited you to join ${org} on Deploi as an admin.`,
      '',
      `Accept the invitation: ${link}`,
      '',
      `The link works once, only for ${email}, and expires on ${expires}.`,
      'If you did not expect this invitation, ignore this email.',
    ].join('\n'))
    expect(String(m.html)).toContain(`href="${link}"`)
    expect(Date.parse(r.expiresAt) - Date.now()).toBeGreaterThan(INVITE_TTL_MS - 60_000)
    // only a digest of the link's nonce is stored; the stored email copy has no usable link
    const row = (await admin(db => db.one<{ token_hash: string; org_role: string }>('select token_hash, org_role from invites where id = $1', [r.inviteId])))!
    expect(row.org_role).toBe('admin')
    expect(tokenFrom(link)).not.toContain(row.token_hash)
    const stored = await admin(db => db.one<{ body_text: string }>(`select body_text from system_emails where related->>'invite_id' = $1`, [r.inviteId]))
    expect(stored!.body_text).not.toContain(tokenFrom(link))
    const info = await inviteInfo(tokenFrom(link))
    expect(info).toMatchObject({ state: 'valid', orgName: org, role: 'admin' })
  })

  it('with email off the invitation is held, and the link is returned to the inviter to share', async () => {
    process.env.EMAIL_LIVE_SENDS = 'off'
    const r = await inviteMember(await merchantActor(NW), addr('held'), 'viewer')
    expect(r.emailStatus).toBe('held')
    expect(r.link).toMatch(/^https:\/\/app\.deploi\.test\/invite\/v1\./)
    expect(sent).toHaveLength(0)
  })

  it('accepting: the profile joins the invited organization with the invited role; user_metadata claims are ignored', async () => {
    const email = addr('newbie')
    const r = await inviteMember(await merchantActor(NW), email, 'member')
    // the person signs up claiming to be an owner of another organization, and staff
    const s = await signUp(email, { role: 'staff', org_role: 'owner', agency_id: HB.org })
    expect(await profile(s.uid)).toEqual({ agency_id: null, org_role: null }) // sign-up alone joins nothing
    const out = await acceptInvite(s, tokenFrom(r.link ?? String(sent[0].body.text).match(/\/invite\/(\S+)/)![0]))
    expect(out).toMatchObject({ orgId: NW.org, role: 'member', appMetadata: 'skipped' })
    expect(await profile(s.uid)).toEqual({ agency_id: NW.org, org_role: 'member' })
    const members = await listMembers(await merchantActor(NW))
    expect(members.members.find(m => m.email === email)).toMatchObject({ role: 'member' })
    expect(members.invites.find(i => i.email === email)).toBeUndefined()
  })

  it('with Supabase configured, the organization is written to app_metadata with the service role (never user_metadata)', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.test'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key'
    const calls: { url: string; method?: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
    setSupabaseAdminFetch(async (url, init) => { calls.push({ url, method: init.method, headers: Object.fromEntries(new Headers(init.headers).entries()), body: JSON.parse(String(init.body)) }); return new Response('{}', { status: 200 }) })
    const email = addr('supa')
    const r = await inviteMember(await merchantActor(NW), email, 'viewer')
    const s = await signUp(email)
    const link = String(sent[0].body.text).match(/\/invite\/(\S+)/)![1]
    expect((await acceptInvite(s, link)).appMetadata).toBe('recorded')
    expect(calls).toEqual([{ url: `https://proj.supabase.test/auth/v1/admin/users/${s.uid}`, method: 'PUT', headers: expect.objectContaining({ apikey: 'service-role-test-key', authorization: 'Bearer service-role-test-key' }), body: { app_metadata: { agency_id: NW.org, role: 'client' } } }])
    expect(JSON.stringify(calls[0].body)).not.toContain('user_metadata')
    expect(r.role).toBe('viewer')
  })

  it('forged and tampered links are refused', async () => {
    const r = await inviteMember(await merchantActor(NW), addr('forge'), 'admin')
    const token = String(sent[0].body.text).match(/\/invite\/(\S+)/)![1]
    const s = await signUp(r.email)
    const parts = token.split('.')
    const forged = [
      'not-a-token', '', `${token}x`,
      [...parts.slice(0, 4), 'A'.repeat(parts[4].length)].join('.'), // wrong signature
      [parts[0], parts[1], parts[2], (parseInt(parts[3], 36) + 86400 * 30).toString(36), parts[4]].join('.'), // later expiry, same signature
      [parts[0], parts[1], 'B'.repeat(22), parts[3], parts[4]].join('.'), // another nonce
    ]
    for (const t of forged) {
      await expect(acceptInvite(s, t)).rejects.toMatchObject({ reason: 'invalid' })
      expect(parseInviteToken(t)).toBeNull()
    }
    // a correctly signed link for an invite that does not exist
    const ghost = makeInviteToken('00000000-0000-4000-8000-0000000000aa', new Date(Date.now() + 864e5)).token
    await expect(acceptInvite(s, ghost)).rejects.toMatchObject({ reason: 'invalid' })
    // signed with another secret
    const prev = process.env.APP_SECRET
    process.env.APP_SECRET = 'another-secret-another-secret-0123456789'
    const other = makeInviteToken(r.inviteId, new Date(Date.now() + 864e5)).token
    process.env.APP_SECRET = prev
    await expect(acceptInvite(s, other)).rejects.toMatchObject({ reason: 'invalid' })
    expect(await profile(s.uid)).toEqual({ agency_id: null, org_role: null })
  })

  it('an expired link is refused (checked against both the link and the record)', async () => {
    const t0 = new Date(Date.now() - INVITE_TTL_MS - 3600e3)
    const r = await inviteMember(await merchantActor(NW), addr('late'), 'member', t0)
    const s = await signUp(r.email)
    const token = String(sent[0].body.text).match(/\/invite\/(\S+)/)![1]
    await expect(acceptInvite(s, token)).rejects.toMatchObject({ reason: 'expired', code: 'expired' })
    expect((await inviteInfo(token)).state).toBe('expired')
    expect((await listMembers(await merchantActor(NW))).invites.find(i => i.email === r.email)).toMatchObject({ expired: true })
  })

  it('a link works once: reusing it is refused, also by another account', async () => {
    const r = await inviteMember(await merchantActor(NW), addr('once'), 'member')
    const token = String(sent[0].body.text).match(/\/invite\/(\S+)/)![1]
    const s = await signUp(r.email)
    await acceptInvite(s, token)
    await expect(acceptInvite(s, token)).rejects.toMatchObject({ reason: 'used' })
    expect((await inviteInfo(token)).state).toBe('used')
  })

  it('the wrong signed-in address is refused and joins nothing', async () => {
    const r = await inviteMember(await merchantActor(NW), addr('right'), 'admin')
    const token = String(sent[0].body.text).match(/\/invite\/(\S+)/)![1]
    const wrong = await signUp(addr('wrong'))
    await expect(acceptInvite(wrong, token)).rejects.toMatchObject({ reason: 'wrong_email', code: 'forbidden' })
    expect(await profile(wrong.uid)).toEqual({ agency_id: null, org_role: null })
    // staff and a member of another organization cannot use it either
    await expect(acceptInvite({ ...(await staffActor() as { session: Session }).session, email: r.email }, token)).rejects.toMatchObject({ reason: 'staff' })
    const right = await signUp(r.email)
    await admin(db => db.query('update profiles set agency_id = $2 where id = $1', [right.uid, HB.org]))
    await expect(acceptInvite(right, token)).rejects.toMatchObject({ reason: 'other_org' })
    expect(await profile(right.uid)).toMatchObject({ agency_id: HB.org })
  })

  it('cross-organization: a link names one invite; another organization cannot resend, revoke or redirect it', async () => {
    const r = await inviteMember(await merchantActor(NW), addr('cross'), 'admin')
    const hb = await merchantActor(HB)
    await expect(resendInvite(hb, r.inviteId)).rejects.toMatchObject({ code: 'not_found' })
    await expect(revokeInvite(hb, r.inviteId)).rejects.toMatchObject({ code: 'not_found' })
    expect((await listMembers(hb)).invites.find(i => i.id === r.inviteId)).toBeUndefined()
    // Harbor invites the same address: a separate invite whose link joins Harbor only
    const h = await inviteMember(hb, r.email, 'viewer')
    expect(h.inviteId).not.toBe(r.inviteId)
    const nwToken = String(sent[0].body.text).match(/\/invite\/(\S+)/)![1]
    const s = await signUp(r.email)
    expect(await acceptInvite(s, nwToken)).toMatchObject({ orgId: NW.org, role: 'admin' })
    expect(await profile(s.uid)).toEqual({ agency_id: NW.org, org_role: 'admin' })
  })

  it('resending rotates the link (the old one stops working); revoking closes it; members and viewers cannot manage invites', async () => {
    const owner = await merchantActor(NW)
    const r = await inviteMember(owner, addr('rot'), 'member')
    const first = String(sent[0].body.text).match(/\/invite\/(\S+)/)![1]
    const again = await resendInvite(owner, r.inviteId)
    expect(again.emailStatus).toBe('sent')
    expect(sent).toHaveLength(2)
    const second = String(sent[1].body.text).match(/\/invite\/(\S+)/)![1]
    expect(second).not.toBe(first)
    const s = await signUp(r.email)
    await expect(acceptInvite(s, first)).rejects.toMatchObject({ reason: 'replaced' })
    await revokeInvite(owner, r.inviteId)
    await expect(acceptInvite(s, second)).rejects.toMatchObject({ reason: 'revoked' })
    expect((await listMembers(owner)).invites.find(i => i.id === r.inviteId)).toBeUndefined()
    // a revoked invite can be sent again on purpose, with a new link
    await resendInvite(owner, r.inviteId)
    const third = String(sent[2].body.text).match(/\/invite\/(\S+)/)![1]
    expect(await acceptInvite(s, third)).toMatchObject({ role: 'member' })
    await expect(resendInvite(owner, r.inviteId)).rejects.toMatchObject({ code: 'not_pending' })
    for (const role of ['member', 'viewer'] as const) {
      const p = await person(NW, role)
      await expect(inviteMember(p, addr('nope'), 'admin')).rejects.toMatchObject({ code: 'forbidden' })
    }
    await expect(inviteMember(owner, addr('own'), 'owner')).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('the last owner is still protected after people join through invitations', async () => {
    const owner = await merchantActor(NW)
    const r = await inviteMember(owner, addr('adm'), 'admin')
    const s = await signUp(r.email)
    await acceptInvite(s, String(sent[0].body.text).match(/\/invite\/(\S+)/)![1])
    const newAdmin = { kind: 'profile' as const, session: { ...s, agencyId: NW.org, orgType: 'merchant' }, orgId: NW.org, label: `user:${s.email}` }
    await expect(changeRole(newAdmin, NW.uid, 'admin')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(removeMember(newAdmin, NW.uid)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(changeRole(owner, NW.uid, 'admin')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(removeMember(owner, NW.uid)).rejects.toMatchObject({ code: 'invalid_input' })
    expect((await listMembers(owner)).members.filter(m => m.role === 'owner').map(m => m.userId)).toEqual([NW.uid])
  })
})
