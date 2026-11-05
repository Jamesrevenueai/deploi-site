/**
 * Organization roles (closes SECURITY-REVIEW F-08). Every person in a merchant organization has one role:
 *
 *   owner   everything an admin can do, plus: delete the organization, make or unmake owners, decide whether
 *           members may approve individual items. An organization always keeps at least one owner.
 *   admin   grant and widen agents (engine, Office, library), set autonomous tiers and auto-run, resume agents,
 *           approve items, billing and plan changes, connect and disconnect accounts, manage members
 *           (except owners), retention settings.
 *   member  day-to-day work: create and edit agents (a widening edit waits for an owner's or admin's grant),
 *           pause and stop agents, reject items, chat. Approves individual items only when the owner allows
 *           it (agencies.members_can_approve, default off).
 *   viewer  read-only: every state-changing API call is refused (lib/store/request.ts resolveActor).
 *
 * Roles are read from the database at the moment of the decision (never from the session cookie), so a
 * role change takes effect at once. Migration 20261105000051 made the oldest member of every existing
 * organization its owner and everyone else an admin, which keeps today's behaviour for existing teams;
 * the first person to join a new organization becomes its owner, later people get the invite's role.
 *
 * Embedded Shopify admin sessions (App Bridge session tokens) identify a Shopify staff user but not
 * whether that user is the shop owner, so they act as `admin`: they can grant and approve as before, but
 * owner-only actions (organization deletion, owner changes) need a signed-in owner in the Deploi web app.
 * Deploi staff are never a role in a merchant organization: they read, they never decide.
 */
import { admin, type Db } from '../db'
import type { Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'

export const ORG_ROLES = ['owner', 'admin', 'member', 'viewer'] as const
export type OrgRole = typeof ORG_ROLES[number]
export const isOrgRole = (v: unknown): v is OrgRole => typeof v === 'string' && (ORG_ROLES as readonly string[]).includes(v)

export type OrgCapability =
  | 'agent.grant'      // grant a version, widen permissions, autonomous tiers, auto-run, switch a library agent on, resume
  | 'approve'          // approve (or retry) one individual item
  | 'billing'          // checkout, portal, plan changes
  | 'connect'          // connect or disconnect an account or store
  | 'members.manage'   // list, invite, change roles, remove (owner rules on top)
  | 'settings'         // retention and other organization settings
  | 'org.approval_policy' // whether members may approve
  | 'org.delete'       // request or cancel deletion of the organization

const ALLOWED: Record<OrgCapability, readonly OrgRole[]> = {
  'agent.grant': ['owner', 'admin'],
  approve: ['owner', 'admin'],
  billing: ['owner', 'admin'],
  connect: ['owner', 'admin'],
  'members.manage': ['owner', 'admin'],
  settings: ['owner', 'admin'],
  'org.approval_policy': ['owner'],
  'org.delete': ['owner'],
}

const LABEL: Record<OrgCapability, string> = {
  'agent.grant': 'grant or widen an agent\'s permissions',
  approve: 'approve items',
  billing: 'manage billing and the plan',
  connect: 'connect or disconnect accounts',
  'members.manage': 'manage members',
  settings: 'change organization settings',
  'org.approval_policy': 'decide who may approve',
  'org.delete': 'delete the organization',
}

/** The actor's role in `orgId` now (null: not a member). Shopify admin users act as admin. */
export async function actorRole(actor: Actor, orgId: string, db?: Db): Promise<OrgRole | null> {
  if (actor.kind === 'staff') return null
  if (actor.orgId !== orgId) return null
  if (actor.kind === 'shopify_user') return 'admin'
  const read = (d: Db) => d.one<{ org_role: string | null }>('select org_role from profiles where id = $1 and agency_id = $2', [actor.session.uid, orgId])
  const r = db ? await read(db) : await admin(read)
  return isOrgRole(r?.org_role) ? r!.org_role as OrgRole : null
}

/** Pure: may this role do this (with the organization's approval setting)? */
export function roleAllows(role: OrgRole | null, cap: OrgCapability, opts: { membersCanApprove?: boolean } = {}): boolean {
  if (!role) return false
  if (cap === 'approve' && role === 'member' && opts.membersCanApprove) return true
  return ALLOWED[cap].includes(role)
}

/** Throws 'forbidden' unless the actor's current role in the organization allows `cap`. Returns the role. */
export async function assertCan(actor: Actor, orgId: string, cap: OrgCapability, db?: Db): Promise<OrgRole> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff can view but not change a customer\'s organization')
  const run = async (d: Db) => {
    const role = await actorRole(actor, orgId, d)
    if (!role) throw new EngineError('forbidden', 'you are not a member of this organization')
    let membersCanApprove = false
    if (cap === 'approve' && role === 'member') membersCanApprove = Boolean((await d.one<{ m: boolean }>('select members_can_approve as m from agencies where id = $1', [orgId]))?.m)
    if (!roleAllows(role, cap, { membersCanApprove })) {
      const who = cap === 'org.delete' || cap === 'org.approval_policy' ? 'an owner' : 'an owner or admin'
      throw new EngineError('forbidden', `your role (${role}) cannot ${LABEL[cap]}; ask ${who}`)
    }
    return role
  }
  return db ? run(db) : admin(run)
}
