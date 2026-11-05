/**
 * Members of a merchant organization and their roles (lib/platform/rbac.ts). Owners and admins manage
 * members; only an owner makes or unmakes an owner, and the last owner can be neither demoted nor removed.
 * Removing a member detaches their sign-in from the organization (their account stays, with no store).
 * Invites (lib/platform/invites.ts) carry the role the person gets when they accept the signed link (admin,
 * member or viewer; an owner is made by promotion). Every change is audited.
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { EngineError } from '../engine/errors'
import type { Actor } from '../engine/actor'
import { assertCan, actorRole, isOrgRole, type OrgRole } from './rbac'

export type Member = { userId: string; email: string; fullName: string | null; role: OrgRole; joinedAt: string; you: boolean }
export type PendingInvite = { id: string; email: string; role: string; invitedAt: string; status: string; expiresAt: string | null; expired: boolean; lastSentAt: string | null; sentCount: number }

function orgOf(actor: Actor): string {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'members belong to a customer organization')
  return actor.orgId
}
const youId = (actor: Actor) => (actor.kind === 'profile' ? actor.session.uid : null)

/** Any member may see who is in the organization and the approval setting. */
export async function listMembers(actor: Actor): Promise<{ members: Member[]; invites: PendingInvite[]; yourRole: OrgRole | null; membersCanApprove: boolean }> {
  const orgId = orgOf(actor)
  return admin(async db => {
    const yourRole = await actorRole(actor, orgId, db)
    if (!yourRole) throw new EngineError('forbidden', 'you are not a member of this organization')
    const rows = await db.query<{ id: string; email: string; full_name: string | null; org_role: OrgRole; created_at: string }>(
      `select id, email, full_name, org_role, created_at::text from profiles where agency_id = $1 and org_role is not null order by array_position(array['owner','admin','member','viewer'], org_role), created_at`, [orgId])
    const invites = await db.query<{ id: string; email: string; org_role: string; invited_at: string; status: string; expires_at: string | null; expired: boolean; last_sent_at: string | null; sent_count: number }>(
      `select id, email, org_role, invited_at::text, status, expires_at::text, coalesce(expires_at <= now(), false) as expired, last_sent_at::text, sent_count from invites where agency_id = $1 and accepted_at is null and status <> 'revoked' order by invited_at desc`, [orgId])
    const org = await db.one<{ members_can_approve: boolean }>('select members_can_approve from agencies where id = $1', [orgId])
    return {
      members: rows.map(r => ({ userId: r.id, email: r.email, fullName: r.full_name, role: r.org_role, joinedAt: r.created_at, you: r.id === youId(actor) })),
      invites: invites.map(i => ({ id: i.id, email: i.email, role: i.org_role, invitedAt: i.invited_at, status: i.status, expiresAt: i.expires_at, expired: i.expired, lastSentAt: i.last_sent_at, sentCount: i.sent_count })),
      yourRole, membersCanApprove: Boolean(org?.members_can_approve),
    }
  })
}

async function lockMembers(db: Db, orgId: string) {
  await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 5521))`, [`members:${orgId}`])
  return db.query<{ id: string; org_role: OrgRole }>(`select id, org_role from profiles where agency_id = $1 and org_role is not null`, [orgId])
}

export async function changeRole(actor: Actor, userId: string, role: unknown) {
  const orgId = orgOf(actor)
  if (!isOrgRole(role)) throw new EngineError('invalid_input', 'role must be owner, admin, member or viewer')
  return admin(async db => {
    const mine = await assertCan(actor, orgId, 'members.manage', db)
    const members = await lockMembers(db, orgId)
    const target = members.find(m => m.id === userId)
    if (!target) throw new EngineError('not_found', 'that person is not a member of this organization')
    if ((role === 'owner' || target.org_role === 'owner') && mine !== 'owner') throw new EngineError('forbidden', 'only an owner can make or unmake an owner')
    if (target.org_role === 'owner' && role !== 'owner' && members.filter(m => m.org_role === 'owner').length <= 1) throw new EngineError('invalid_input', 'the organization must keep at least one owner: make someone else an owner first')
    if (target.org_role === role) return { userId, role }
    await db.query('update profiles set org_role = $2 where id = $1 and agency_id = $3', [userId, role, orgId])
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'members.role_changed', actor: actor.label, detail: { user_id: userId, from: target.org_role, to: role } })
    return { userId, role }
  })
}

export async function removeMember(actor: Actor, userId: string) {
  const orgId = orgOf(actor)
  return admin(async db => {
    const self = youId(actor) === userId
    const mine = self ? await actorRole(actor, orgId, db) : await assertCan(actor, orgId, 'members.manage', db)
    const members = await lockMembers(db, orgId)
    const target = members.find(m => m.id === userId)
    if (!target) throw new EngineError('not_found', 'that person is not a member of this organization')
    if (target.org_role === 'owner' && mine !== 'owner') throw new EngineError('forbidden', 'only an owner can remove an owner')
    if (target.org_role === 'owner' && members.filter(m => m.org_role === 'owner').length <= 1) throw new EngineError('invalid_input', 'the last owner cannot be removed: make someone else an owner first, or delete the organization')
    await db.query('update profiles set agency_id = null, org_role = null where id = $1 and agency_id = $2', [userId, orgId])
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'members.removed', actor: actor.label, detail: { user_id: userId, role: target.org_role, self } })
    return { removed: userId }
  })
}

export { inviteMember, resendInvite, revokeInvite } from './invites'

/** Owner only: may members (not only owners and admins) approve individual items? */
export async function setApprovalPolicy(actor: Actor, membersCanApprove: unknown) {
  const orgId = orgOf(actor)
  if (typeof membersCanApprove !== 'boolean') throw new EngineError('invalid_input', 'membersCanApprove must be true or false')
  return admin(async db => {
    await assertCan(actor, orgId, 'org.approval_policy', db)
    await db.query('update agencies set members_can_approve = $2 where id = $1', [orgId, membersCanApprove])
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'org.approval_policy', actor: actor.label, detail: { members_can_approve: membersCanApprove } })
    return { membersCanApprove }
  })
}
