/**
 * Organization roles (SECURITY-REVIEW F-08): owner / admin / member / viewer x grant / widen / approve /
 * billing / connect on the engine, Office and library paths; last-owner protection; viewers read-only.
 */
import '../library/helpers'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { NW, HB, merchantActor, resetMerchant } from '../merchant/helpers'
import { resetLibrary, actionsOf } from '../library/helpers'
import { resetOffice } from '../office/helpers'
import { person, removePeople } from './helpers'
import { createAgent, editAgent, grantPolicy, pauseAgent, resumeAgent } from '../../lib/agents/lifecycle'
import { runAgent } from '../../lib/agents/run'
import { approveProposal } from '../../lib/engine/approve'
import { createOfficeAgent, grantOfficePolicy } from '../../lib/office/agents'
import { connectSyntheticOffice, disconnectOffice } from '../../lib/office/connections'
import { connectSyntheticMailbox } from '../../lib/office/mailbox'
import { officeTemplatePolicy } from '../../lib/office/templates'
import { decideOfficeAction } from '../../lib/office/approvals'
import { startConnect } from '../../lib/email/accounts'
import { setSwitch, setPermission, grantAutoRun, setTier } from '../../lib/library/switches'
import { runLibraryAgent, approveAction, declineAction } from '../../lib/library/actions'
import { createCustomAgent } from '../../lib/library/custom'
import { assertCan, roleAllows, ORG_ROLES, type OrgRole, type OrgCapability } from '../../lib/platform/rbac'
import { changeRole, inviteMember, listMembers, removeMember, setApprovalPolicy } from '../../lib/platform/members'
import { DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'
import type { Actor } from '../../lib/engine/actor'

const ready = await prepareDb()
const STOCK = { connectionId: NW.conn, productScope: { mode: 'all' }, correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: DEFAULT_EXEMPT_TAGS, flagInStockVariants: true } } }
const forbidden = { code: 'forbidden' }
const roles = async () => ({ owner: await merchantActor(NW), admin: await person(NW, 'admin'), member: await person(NW, 'member'), viewer: await person(NW, 'viewer') }) as Record<OrgRole, Actor>
const draftAgent = async (actor: Actor, name: string, policy: Record<string, unknown> = {}) => createAgent(actor, { name, taskText: `${name} task`, policy: { ...STOCK, ...policy } })

describe.skipIf(!ready)('organization roles (F-08)', () => {
  beforeEach(async () => { await resetMerchant(NW); await resetMerchant(HB) })
  afterAll(async () => { if (ready) { await removePeople(NW); await resetMerchant(NW) } })

  it('the matrix: owners and admins grant, approve, bill and connect; members approve only when the owner allows; viewers nothing', () => {
    const caps: OrgCapability[] = ['agent.grant', 'approve', 'billing', 'connect', 'members.manage', 'settings', 'org.approval_policy', 'org.delete']
    const table = Object.fromEntries(ORG_ROLES.map(r => [r, caps.filter(c => roleAllows(r, c))]))
    expect(table).toEqual({
      owner: caps,
      admin: ['agent.grant', 'approve', 'billing', 'connect', 'members.manage', 'settings'],
      member: [], viewer: [],
    })
    expect(roleAllows('member', 'approve', { membersCanApprove: true })).toBe(true)
    expect(roleAllows('viewer', 'approve', { membersCanApprove: true })).toBe(false)
    expect(roleAllows('member', 'agent.grant', { membersCanApprove: true })).toBe(false)
    expect(roleAllows(null, 'approve')).toBe(false)
  })

  it('migration: the existing seeded owner is the owner; a person joining later gets the invite role, the first person in a new org is its owner', async () => {
    expect((await listMembers(await merchantActor(NW))).yourRole).toBe('owner')
    const owner = await merchantActor(NW)
    await inviteMember(owner, 'invited.viewer@rbac.example', 'viewer')
    const uid = '00000000-0000-4000-8000-00000000f0a1'
    const org = '00000000-0000-4000-8000-00000000f0b1'
    try {
      await admin(async db => {
        await db.query(`insert into auth.users (id, email) values ($1, 'invited.viewer@rbac.example') on conflict do nothing`, [uid])
        await db.query(`update profiles set agency_id = $2 where id = $1`, [uid, NW.org])
      })
      expect(await admin(db => db.one('select org_role from profiles where id = $1', [uid]))).toEqual({ org_role: 'viewer' })
      // a brand-new organization: its first member becomes the owner
      await admin(async db => {
        await db.query(`insert into agencies (id, name, state, org_type) values ($1, 'Fresh Org', '', 'merchant') on conflict do nothing`, [org])
        await db.query(`update profiles set agency_id = $2 where id = $1`, [uid, org])
      })
      expect(await admin(db => db.one('select org_role from profiles where id = $1', [uid]))).toEqual({ org_role: 'owner' })
    } finally {
      await admin(async db => { await db.query('delete from auth.users where id = $1', [uid]); await db.query('delete from invites where agency_id = $1', [NW.org]); await db.query('delete from agencies where id = $1', [org]) })
    }
  })

  it('engine: grant and widen need an owner or admin; members create drafts and pause; resume needs an owner or admin', async () => {
    const r = await roles()
    for (const who of ['member', 'viewer'] as const) {
      const d = await draftAgent(r.member, `Draft by member for ${who}`)
      await expect(grantPolicy(r[who], d.agentId, d.policyId, d.policyHash)).rejects.toMatchObject(forbidden)
    }
    const d = await draftAgent(r.member, 'Granted by admin')
    await grantPolicy(r.admin, d.agentId, d.policyId, d.policyHash)
    // widening (drafts -> autonomous) waits for a grant, which a member cannot give
    const e = await editAgent(r.member, d.agentId, { policy: { ...STOCK, approvalMode: 'autonomous', validUntil: new Date(Date.now() + 30 * 864e5).toISOString() } })
    expect(e.requiresGrant).toBe(true)
    await expect(grantPolicy(r.member, d.agentId, e.policyId, e.policyHash)).rejects.toMatchObject(forbidden)
    await grantPolicy(r.owner, d.agentId, e.policyId, e.policyHash)
    await pauseAgent(r.member, d.agentId)
    await expect(resumeAgent(r.member, d.agentId)).rejects.toMatchObject(forbidden)
    await resumeAgent(r.admin, d.agentId)
  })

  it('engine approvals: owners and admins approve; members only when the owner allows it; viewers never', async () => {
    await resetMerchant(NW, { ruleOn: false })
    const r = await roles()
    const d = await draftAgent(r.owner, 'Reviewer', { approvalMode: 'review' })
    await grantPolicy(r.owner, d.agentId, d.policyId, d.policyHash)
    await runAgent(d.agentId, { trigger: 'test', actor: 'test' })
    const pending = await admin(db => db.query<{ id: string; change_hash: string }>(`select id, change_hash from proposals where agent_id = $1 and status = 'pending_approval' order by created_at`, [d.agentId]))
    expect(pending.length).toBeGreaterThanOrEqual(2)
    await expect(approveProposal(r.member, pending[0].id, pending[0].change_hash)).rejects.toMatchObject(forbidden)
    await expect(approveProposal(r.viewer, pending[0].id, pending[0].change_hash)).rejects.toMatchObject(forbidden)
    await expect(setApprovalPolicy(r.admin, true)).rejects.toMatchObject(forbidden) // only the owner decides
    await setApprovalPolicy(r.owner, true)
    expect(await approveProposal(r.member, pending[0].id, pending[0].change_hash)).toHaveProperty('approvalId')
    await expect(approveProposal(r.viewer, pending[1].id, pending[1].change_hash)).rejects.toMatchObject(forbidden)
    await setApprovalPolicy(r.owner, false)
    await expect(approveProposal(r.member, pending[1].id, pending[1].change_hash)).rejects.toMatchObject(forbidden)
    expect(await approveProposal(r.admin, pending[1].id, pending[1].change_hash)).toHaveProperty('approvalId')
  })

  it('Office: connect and disconnect, grant and approve need an owner or admin', async () => {
    await resetOffice(NW)
    const r = await roles()
    await expect(connectSyntheticOffice(r.member, 'hubspot', { demoData: false })).rejects.toMatchObject(forbidden)
    await expect(connectSyntheticOffice(r.viewer, 'hubspot', { demoData: false })).rejects.toMatchObject(forbidden)
    const hub = await connectSyntheticOffice(r.admin, 'hubspot', { demoData: false })
    const cal = await connectSyntheticOffice(r.owner, 'google_calendar', { timezone: 'UTC' })
    const mb = await connectSyntheticMailbox(r.owner, 'office@northwind-office.example')
    const policy = officeTemplatePolicy('lead_followup', { hubspotConnectionId: hub.id, calendarConnectionId: cal.id, mailboxAccountId: mb.id, timezone: 'UTC', senderName: 'Sam', pitch: 'We make tableware.' })
    const a = await createOfficeAgent(r.member, { kind: 'lead_followup', name: 'Follow-up', policy })
    await expect(grantOfficePolicy(r.member, a.agentId, a.policyId, a.policyHash)).rejects.toMatchObject(forbidden)
    await expect(grantOfficePolicy(r.viewer, a.agentId, a.policyId, a.policyHash)).rejects.toMatchObject(forbidden)
    await grantOfficePolicy(r.admin, a.agentId, a.policyId, a.policyHash)
    // one item waiting for approval
    const id = (await admin(db => db.one<{ id: string }>(`insert into office_actions (org_id, agent_id, kind, purpose, idempotency_key, status, payload, payload_hash)
      values ($1,$2,'crm_note','rbac test','rbac-1','awaiting_approval','{"type":"crm","note":"x"}',repeat('a',64)) returning id`, [NW.org, a.agentId])))!.id
    await expect(admin(db => decideOfficeAction(db, r.member, id, 'approve'))).rejects.toMatchObject(forbidden)
    await expect(admin(db => decideOfficeAction(db, r.viewer, id, 'approve'))).rejects.toMatchObject(forbidden)
    // the role gate passes for an admin (the item then fails on its own merits, not on the role)
    await expect(admin(db => decideOfficeAction(db, r.admin, id, 'approve'))).rejects.not.toMatchObject(forbidden)
    expect(await admin(db => decideOfficeAction(db, r.member, id, 'reject'))).toMatchObject({ status: 'rejected' }) // rejecting is always allowed
    await expect(disconnectOffice(r.member, hub.id)).rejects.toMatchObject(forbidden)
    expect(await disconnectOffice(r.admin, hub.id)).toHaveProperty('credentialDeleted')
    await resetOffice(NW)
  })

  it('library: switching on, widening the permission, auto-run and Build-your-own grants need an owner or admin; narrowing does not', async () => {
    await resetLibrary(NW, 'pro')
    const r = await roles()
    await expect(setSwitch(r.member, 'listing_writer', true)).rejects.toMatchObject(forbidden)
    await setSwitch(r.admin, 'listing_writer', true)
    await expect(setPermission(r.member, 'listing_writer', 'act')).rejects.toMatchObject(forbidden)
    await expect(setPermission(r.viewer, 'listing_writer', 'act')).rejects.toMatchObject(forbidden)
    await setPermission(r.owner, 'listing_writer', 'act')
    await expect(grantAutoRun(r.member, 'listing_writer', 'draft_description', 5)).rejects.toMatchObject(forbidden)
    await grantAutoRun(r.admin, 'listing_writer', 'draft_description', 5)
    await setPermission(r.member, 'listing_writer', 'draft') // narrowing: any member
    await expect(createCustomAgent(r.member, { name: 'Mine', job: 'write product descriptions', permission: 'act' })).rejects.toMatchObject(forbidden)
    expect(await createCustomAgent(r.member, { name: 'Mine', job: 'write product descriptions' })).toMatchObject({ permission: 'read' })
    // approvals of library drafts
    await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: 'test', now: new Date('2026-10-29T12:00:00Z') })
    const drafts = (await actionsOf(NW, 'listing_writer')).filter(a => a.status === 'draft')
    expect(drafts.length).toBeGreaterThan(1)
    await expect(approveAction(r.member, drafts[0].id, new Date('2026-10-29T12:00:00Z'))).rejects.toMatchObject(forbidden)
    await expect(approveAction(r.viewer, drafts[0].id, new Date('2026-10-29T12:00:00Z'))).rejects.toMatchObject(forbidden)
    await approveAction(r.admin, drafts[0].id, new Date('2026-10-29T12:00:00Z'))
    await declineAction(r.member, drafts[1].id, 'not now', new Date('2026-10-29T12:00:00Z'))
    // the plan is a billing decision
    await expect(setTier(r.member, 'growth')).rejects.toMatchObject(forbidden)
    await setTier(r.admin, 'pro')
  })

  it('billing and connect: members and viewers are refused, staff are never a role, Shopify admin users act as admin', async () => {
    const r = await roles()
    for (const who of ['member', 'viewer'] as const) {
      await expect(assertCan(r[who], NW.org, 'billing')).rejects.toMatchObject(forbidden)
      await expect(assertCan(r[who], NW.org, 'connect')).rejects.toMatchObject(forbidden)
      await expect(startConnect(r[who], { provider: 'synthetic' })).rejects.toMatchObject(forbidden)
    }
    expect(await assertCan(r.admin, NW.org, 'billing')).toBe('admin')
    const shop: Actor = { kind: 'shopify_user', orgId: NW.org, shop: NW.domain, userId: '42', label: 'shopify:test' }
    expect(await assertCan(shop, NW.org, 'agent.grant')).toBe('admin')
    await expect(assertCan(shop, NW.org, 'org.delete')).rejects.toMatchObject(forbidden)
    // another organization's admin has no role here
    await expect(assertCan(r.admin, HB.org, 'approve')).rejects.toMatchObject(forbidden)
    const staff: Actor = { kind: 'staff', session: { uid: '00000000-0000-4000-8000-000000000001', email: 'hello@getdeploi.com', role: 'staff', agencyId: null }, label: 'staff:x' }
    await expect(assertCan(staff, NW.org, 'approve')).rejects.toMatchObject(forbidden)
  })

  it('members: owners and admins manage; only an owner makes an owner; the last owner can be neither demoted nor removed', async () => {
    const r = await roles()
    const ownerId = (r.owner as Actor & { kind: 'profile' }).session.uid
    const adminId = (r.admin as Actor & { kind: 'profile' }).session.uid
    const memberId = (r.member as Actor & { kind: 'profile' }).session.uid
    const list = await listMembers(r.viewer)
    expect(list.members.map(m => m.role)).toEqual(['owner', 'admin', 'member', 'viewer'])
    await expect(changeRole(r.member, adminId, 'member')).rejects.toMatchObject(forbidden)
    await expect(changeRole(r.admin, memberId, 'owner')).rejects.toMatchObject(forbidden)
    await expect(changeRole(r.admin, ownerId, 'admin')).rejects.toMatchObject(forbidden)
    await expect(changeRole(r.owner, ownerId, 'admin')).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/at least one owner/) })
    await expect(removeMember(r.owner, ownerId)).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/last owner/) })
    await changeRole(r.admin, memberId, 'viewer')
    await changeRole(r.owner, adminId, 'owner')
    // two owners now: one may step down
    await changeRole(r.owner, adminId, 'admin')
    await removeMember(r.admin, memberId)
    expect((await listMembers(r.owner)).members.map(m => m.userId)).not.toContain(memberId)
    await expect(inviteMember(r.admin, 'new.person@rbac.example', 'owner')).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await inviteMember(r.admin, 'new.person@rbac.example', 'viewer')).toMatchObject({ email: 'new.person@rbac.example', role: 'viewer', emailStatus: 'held' })
    expect((await listMembers(r.owner)).invites).toEqual([expect.objectContaining({ email: 'new.person@rbac.example', role: 'viewer' })])
    await admin(db => db.query(`delete from invites where agency_id = $1`, [NW.org]))
  })

  it('viewers are read-only at the API boundary: resolveActor refuses every state-changing call', async () => {
    const src = (await import('node:fs')).readFileSync('lib/store/request.ts', 'utf8')
    expect(src).toMatch(/if \(opts\.mutating && s\.orgRole === 'viewer'\) throw new HttpError\(403, 'read_only_role'/)
    // the session carries the role read from the profile on every request
    expect((await import('node:fs')).readFileSync('lib/auth.ts', 'utf8')).toMatch(/p\.org_role from profiles p/)
  })
})
