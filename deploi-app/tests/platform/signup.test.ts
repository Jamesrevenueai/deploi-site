/**
 * A brand-new sign-up: the profile has no organization (whatever the person put in user_metadata), lands on the
 * first run (/start), and gets an organization of its own as owner through server code (lib/platform/signup.ts).
 */
import '../merchant/env'
import { describe, it, expect, afterEach } from 'vitest'
import { prepareDb, SESSIONS, ORG_NW } from '../db/helpers'
import { admin } from '../../lib/db'
import { homeFor, type Session } from '../../lib/session'
import { createOwnOrganization } from '../../lib/platform/signup'
import { listMembers } from '../../lib/platform/members'
import { wizardView } from '../../lib/library/onboarding'
import { setSupabaseAdminFetch } from '../../lib/supabase/admin-api'
import { safeNextPath } from '../../lib/safe-next'

const ready = await prepareDb()
const users: string[] = []
const orgs: string[] = []

async function signUp(email: string, userMeta: Record<string, unknown> = {}): Promise<Session> {
  const id = await admin(async db => (await db.one<{ id: string }>(`insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), $1, $2) returning id`, [email, JSON.stringify(userMeta)]))!.id)
  users.push(id)
  const p = (await admin(db => db.one<{ agency_id: string | null; role: 'client' | 'staff'; org_role: string | null }>('select agency_id, role, org_role from profiles where id = $1', [id])))!
  return { uid: id, email, role: p.role, agencyId: p.agency_id, orgRole: p.org_role }
}

describe.skipIf(!ready)('sign-up and first run', () => {
  afterEach(async () => {
    setSupabaseAdminFetch(null)
    delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY
    await admin(async db => {
      if (users.length) { await db.query('delete from profiles where id = any($1)', [users]); await db.query('delete from auth.users where id = any($1)', [users]) }
      if (orgs.length) await db.query('delete from agencies where id = any($1)', [orgs])
    })
    users.length = 0; orgs.length = 0
  })

  it('a new user with no organization gets one of their own, as owner, and the setup starts at the next step', async () => {
    const s = await signUp(`founder.${Date.now()}@new-business.example`, { agency_id: ORG_NW, role: 'staff', org_role: 'owner' })
    expect(s).toMatchObject({ role: 'client', agencyId: null, orgRole: null }) // user_metadata assigned nothing
    expect(homeFor({ role: s.role, orgType: null, agencyId: s.agencyId })).toBe('/start')
    const r = await createOwnOrganization(s, { name: '  Bright   Candles  ', timezone: 'Europe/London' })
    orgs.push(r.orgId)
    expect(r).toMatchObject({ created: true, appMetadata: 'skipped' })
    expect(r.orgId).not.toBe(ORG_NW)
    const org = await admin(db => db.one<{ name: string; timezone: string; org_type: string }>('select name, timezone, org_type from agencies where id = $1', [r.orgId]))
    expect(org).toEqual({ name: 'Bright Candles', timezone: 'Europe/London', org_type: 'merchant' })
    const p = await admin(db => db.one<{ agency_id: string; org_role: string }>('select agency_id, org_role from profiles where id = $1', [s.uid]))
    expect(p).toEqual({ agency_id: r.orgId, org_role: 'owner' })
    // the new owner sees only themselves; the first run continues after the business step
    const actor = { kind: 'profile' as const, session: { ...s, agencyId: r.orgId, orgType: 'merchant', orgRole: 'owner' }, orgId: r.orgId, label: `user:${s.email}` }
    const m = await listMembers(actor)
    expect(m).toMatchObject({ yourRole: 'owner', members: [expect.objectContaining({ userId: s.uid, role: 'owner', you: true })], invites: [] })
    const v = await wizardView(actor)
    expect(v.business).toMatchObject({ name: 'Bright Candles', timezone: 'Europe/London', saved: true })
    expect(v.current).toBe('products')
    expect(homeFor({ role: 'client', orgType: 'merchant', agencyId: r.orgId })).toBe('/store')
  })

  it('a second click creates nothing new; staff cannot; bad input is refused', async () => {
    const s = await signUp(`twice.${Date.now()}@new-business.example`)
    const a = await createOwnOrganization(s, { name: 'Twice Co' })
    orgs.push(a.orgId)
    const b = await createOwnOrganization(s, { name: 'Twice Co again' })
    expect(b).toEqual({ orgId: a.orgId, created: false, appMetadata: 'unchanged' })
    expect((await admin(db => db.one<{ n: number }>(`select count(*)::int as n from agencies where name like 'Twice Co%'`)))!.n).toBe(1)
    const fresh = await signUp(`bad.${Date.now()}@new-business.example`)
    await expect(createOwnOrganization(fresh, { name: '' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(createOwnOrganization(fresh, { name: 'x'.repeat(121) })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(createOwnOrganization(fresh, { name: 'Ok', timezone: 'Mars/Base' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(createOwnOrganization(SESSIONS.staff, { name: 'Staff Co' })).rejects.toMatchObject({ code: 'forbidden' })
    // someone already in an organization is not given a second one
    expect(await createOwnOrganization(SESSIONS.northwind, { name: 'Another' })).toMatchObject({ orgId: ORG_NW, created: false })
  })

  it('with Supabase configured the new organization is recorded in app_metadata by the service role', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.test'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test-key'
    const bodies: unknown[] = []
    setSupabaseAdminFetch(async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return new Response('{}', { status: 200 }) })
    const s = await signUp(`supa.${Date.now()}@new-business.example`)
    const r = await createOwnOrganization(s, { name: 'Supa Shop' })
    orgs.push(r.orgId)
    expect(r.appMetadata).toBe('recorded')
    expect(bodies).toEqual([{ app_metadata: { agency_id: r.orgId, role: 'client' } }])
    // a Supabase failure is reported, and the organization is still created by our own server code
    setSupabaseAdminFetch(async () => new Response('{}', { status: 500 }))
    const t = await signUp(`supa2.${Date.now()}@new-business.example`)
    const r2 = await createOwnOrganization(t, { name: 'Supa Shop 2' })
    orgs.push(r2.orgId)
    expect(r2).toMatchObject({ created: true, appMetadata: 'failed' })
  })

  it('after signing in, only an invitation or the first run can be returned to (no open redirect)', () => {
    expect(safeNextPath('/start')).toBe('/start')
    expect(safeNextPath('/invite/v1.abc.def')).toBe('/invite/v1.abc.def')
    for (const bad of ['//evil.example', 'https://evil.example', '/store/../../evil', '/invite/a b', '/\\evil.example', null, 7]) expect(safeNextPath(bad)).toBeNull()
  })
})
