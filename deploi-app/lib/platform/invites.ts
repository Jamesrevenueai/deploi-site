/**
 * Member invitations with a signed, expiring, single-use link.
 *
 * The link is /invite/<token>, token = v1.<invite id>.<nonce>.<expiry>.<signature>:
 *  - signature: HMAC-SHA256 over the other parts with INVITE_SECRET (or APP_SECRET; 32+ characters). A token
 *    whose parts were changed (another invite id, a later expiry) fails the signature, so it cannot be pointed
 *    at another organization's invite.
 *  - nonce: 16 random bytes. Only its SHA-256 digest is stored (invites.token_hash). Resending rotates it, so
 *    the previous link stops working; accepting clears it, so the link works once.
 *  - expiry: 7 days from the (re)send, checked against both the token and the row.
 *
 * Acceptance (acceptInvite) is server code only: the signed-in address must be the invited one; the person
 * joins the invite's organization with the invite's role (never owner; owners are made by promotion), and when
 * Supabase is configured the organization is recorded in the user's app_metadata with the service role. Nothing
 * a user can set (user_metadata, a request field) chooses the organization or the role.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { admin, type Db } from '../db'
import { env } from '../env'
import { audit } from '../engine/audit'
import { EngineError } from '../engine/errors'
import type { Actor } from '../engine/actor'
import type { Session } from '../session'
import { sendSystemEmail, type SystemEmailStatus } from '../email/system'
import { setAppMetadata } from '../supabase/admin-api'
import { assertCan } from './rbac'

export const INVITE_TTL_MS = 7 * 864e5
export const INVITE_ROLES = ['admin', 'member', 'viewer'] as const
export type InviteRole = typeof INVITE_ROLES[number]
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type InviteRefusal = 'invalid' | 'replaced' | 'expired' | 'revoked' | 'used' | 'wrong_email' | 'other_org' | 'already_member' | 'staff'
export class InviteError extends EngineError {
  constructor(public reason: InviteRefusal, message: string) {
    super(reason === 'expired' ? 'expired' : reason === 'invalid' || reason === 'replaced' ? 'invalid_input' : reason === 'wrong_email' || reason === 'staff' || reason === 'other_org' ? 'forbidden' : 'not_pending', message, { reason })
    this.name = 'InviteError'
  }
}

function secret(): string {
  const k = ((process.env.INVITE_SECRET ?? '').trim() || env.appSecret)
  if (k.length < 32) throw new EngineError('not_operational', 'invitations need INVITE_SECRET or APP_SECRET (at least 32 characters) to sign their links')
  return k
}
const sign = (payload: string, key: string) => createHmac('sha256', key).update(`deploi-invite:${payload}`).digest('base64url')
const digest = (nonce: string) => createHash('sha256').update(nonce).digest('hex')

export function makeInviteToken(inviteId: string, expiresAt: Date): { token: string; nonceHash: string } {
  const nonce = randomBytes(16).toString('base64url')
  const payload = `v1.${inviteId.replace(/-/g, '')}.${nonce}.${Math.floor(expiresAt.getTime() / 1000).toString(36)}`
  return { token: `${payload}.${sign(payload, secret())}`, nonceHash: digest(nonce) }
}

/** Pure: parse and check the signature. Null when the token is malformed or forged. */
export function parseInviteToken(token: string): { inviteId: string; nonceHash: string; exp: number } | null {
  if (typeof token !== 'string' || token.length > 300) return null
  const parts = token.split('.')
  if (parts.length !== 5 || parts[0] !== 'v1' || !/^[0-9a-f]{32}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{22}$/.test(parts[2]) || !/^[0-9a-z]{1,10}$/.test(parts[3])) return null
  let key: string
  try { key = secret() } catch { return null }
  const want = Buffer.from(sign(parts.slice(0, 4).join('.'), key))
  const got = Buffer.from(parts[4])
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  const h = parts[1]
  return { inviteId: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`, nonceHash: digest(parts[2]), exp: parseInt(parts[3], 36) * 1000 }
}

export const inviteLink = (token: string) => `${env.appUrl.replace(/\/$/, '')}/invite/${token}`
export function maskEmail(e: string): string {
  const [local, domain] = e.split('@')
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`
}
const roleArticle = (r: string) => (/^[aeiou]/.test(r) ? 'an' : 'a')

type InviteRow = { id: string; agency_id: string; email: string; org_role: InviteRole; status: string; token_hash: string | null; expires_at: string | null; accepted_at: string | null; revoked_at: string | null; org_name: string; invited_by: string | null }
const ROW = `select i.id, i.agency_id, i.email, i.org_role, i.status, i.token_hash, i.expires_at::text, i.accepted_at::text, i.revoked_at::text, g.name as org_name, i.invited_by from invites i join agencies g on g.id = i.agency_id`

const MESSAGES: Record<InviteRefusal, (i?: InviteRow) => string> = {
  invalid: () => 'This invitation link is not valid. Ask the person who invited you to send it again.',
  replaced: () => 'This invitation link was replaced by a newer one. Use the link in the most recent invitation email.',
  expired: i => `This invitation${i ? ` to ${i.org_name}` : ''} has expired. Ask an owner or admin to send it again.`,
  revoked: i => `This invitation${i ? ` to ${i.org_name}` : ''} was withdrawn.`,
  used: i => `This invitation${i ? ` to ${i.org_name}` : ''} has already been used.`,
  wrong_email: i => `This invitation is for ${i ? maskEmail(i.email) : 'another address'}. Sign out, then sign in with the invited address.`,
  other_org: () => 'Your account already belongs to another organization. Ask Deploi support to move it.',
  already_member: i => `You are already a member of ${i?.org_name ?? 'this organization'}.`,
  staff: () => 'Deploi staff accounts cannot join a customer organization.',
}
const refuse = (reason: InviteRefusal, i?: InviteRow) => new InviteError(reason, MESSAGES[reason](i))

/** Check a token against its invite (no side effects). Throws an InviteError naming why it is refused. */
async function checkToken(db: Db, token: string, now: Date, lock = false): Promise<InviteRow> {
  const t = parseInviteToken(token)
  if (!t) throw refuse('invalid')
  const i = await db.one<InviteRow>(`${ROW} where i.id = $1${lock ? ' for update of i' : ''}`, [t.inviteId])
  if (!i) throw refuse('invalid')
  if (i.accepted_at || i.status === 'accepted') throw refuse('used', i)
  if (i.revoked_at || i.status === 'revoked') throw refuse('revoked', i)
  if (!i.token_hash || i.token_hash !== t.nonceHash) throw refuse('replaced', i)
  if (t.exp <= now.getTime() || !i.expires_at || Date.parse(i.expires_at) <= now.getTime()) throw refuse('expired', i)
  return i
}

export type InviteInfo =
  | { state: 'valid'; orgName: string; role: InviteRole; email: string; maskedEmail: string; expiresAt: string }
  | { state: InviteRefusal; message: string; orgName: string | null }

/** What the accept page shows for a token. */
export async function inviteInfo(token: string, now = new Date()): Promise<InviteInfo> {
  return admin(async db => {
    try {
      const i = await checkToken(db, token, now)
      return { state: 'valid', orgName: i.org_name, role: i.org_role, email: i.email, maskedEmail: maskEmail(i.email), expiresAt: i.expires_at! }
    } catch (e) {
      if (e instanceof InviteError) {
        const t = parseInviteToken(token)
        const org = t ? await db.one<{ name: string }>('select g.name from invites i join agencies g on g.id = i.agency_id where i.id = $1', [t.inviteId]) : null
        return { state: e.reason, message: e.message, orgName: org?.name ?? null }
      }
      throw e
    }
  })
}

function orgOf(actor: Actor): string {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'members belong to a customer organization')
  return actor.orgId
}

export type InviteSendResult = { inviteId: string; email: string; role: InviteRole; expiresAt: string; emailStatus: SystemEmailStatus; emailReason: string | null; link?: string }

/** Issue (or rotate) the invite's link and email it. The link is returned only when the email was not sent. */
async function issue(db: Db, actor: Actor, inviteId: string, now: Date): Promise<InviteSendResult> {
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS)
  const { token, nonceHash } = makeInviteToken(inviteId, expiresAt)
  const i = (await db.one<InviteRow & { sent_count: number }>(
    `update invites set token_hash = $2, expires_at = $3, last_sent_at = $4, sent_count = sent_count + 1, status = 'pending' where id = $1
     returning id, agency_id, email, org_role, status, sent_count, (select name from agencies where id = agency_id) as org_name`, [inviteId, nonceHash, expiresAt.toISOString(), now.toISOString()]))!
  const inviter = actor.kind === 'profile' ? (actor.session.fullName || actor.session.email) : 'Your store admin'
  const mail = await sendSystemEmail({
    key: `invite:${inviteId}:${nonceHash.slice(0, 16)}`, template: 'member_invite', to: i.email, orgId: i.agency_id,
    params: { inviter, org: i.org_name, role: i.org_role, roleArticle: roleArticle(i.org_role), link: inviteLink(token), email: i.email, expires: expiresAt.toISOString().slice(0, 10) },
    secretParams: ['link'], related: { invite_id: inviteId, send: i.sent_count },
  })
  return { inviteId, email: i.email, role: i.org_role, expiresAt: expiresAt.toISOString(), emailStatus: mail.status, emailReason: mail.reason, ...(mail.status === 'sent' ? {} : { link: inviteLink(token) }) }
}

/** Owners and admins: invite an address with a role (admin, member or viewer). Re-inviting an open address rotates its link. */
export async function inviteMember(actor: Actor, email: unknown, role: unknown = 'member', now = new Date()): Promise<InviteSendResult> {
  const orgId = orgOf(actor)
  if (typeof email !== 'string' || !EMAIL.test(email.trim()) || /[\r\n]/.test(email)) throw new EngineError('invalid_input', 'a valid e-mail address is required')
  if (!INVITE_ROLES.includes(role as InviteRole)) throw new EngineError('invalid_input', 'an invite gives admin, member or viewer (promote to owner after they join)')
  secret()
  return admin(async db => {
    await assertCan(actor, orgId, 'members.manage', db)
    const addr = email.trim().toLowerCase()
    const existing = await db.one<{ agency_id: string | null; role: string }>('select agency_id, role::text from profiles where lower(email) = $1', [addr])
    if (existing?.agency_id === orgId) throw new EngineError('invalid_input', 'that person is already a member')
    if (existing?.role === 'staff') throw new EngineError('invalid_input', 'Deploi staff accounts cannot be invited to an organization')
    if (existing?.agency_id) throw new EngineError('invalid_input', 'that address already belongs to another organization; ask Deploi support to move it')
    const inviter = actor.kind === 'profile' ? actor.session.uid : null
    const row = (await db.one<{ id: string }>(`insert into invites (agency_id, email, role, org_role, invited_by, status) values ($1,$2,'client',$3,$4,'pending')
      on conflict (agency_id, lower(email)) do update set org_role = excluded.org_role, invited_by = excluded.invited_by, invited_at = now(), status = 'pending', accepted_at = null, accepted_by = null, revoked_at = null
      returning id`, [orgId, addr, role, inviter]))!
    const out = await issue(db, actor, row.id, now)
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'members.invited', actor: actor.label, detail: { invite_id: row.id, role, email_status: out.emailStatus } })
    return out
  })
}

async function openInvite(db: Db, orgId: string, inviteId: unknown) {
  if (typeof inviteId !== 'string' || !UUID.test(inviteId)) throw new EngineError('invalid_input', 'inviteId is required')
  const i = await db.one<{ id: string; accepted_at: string | null; status: string }>('select id, accepted_at::text, status from invites where id = $1 and agency_id = $2 for update', [inviteId, orgId])
  if (!i) throw new EngineError('not_found', 'no such invitation in this organization')
  if (i.accepted_at || i.status === 'accepted') throw new EngineError('not_pending', 'that invitation was already accepted')
  return i
}

/** Send the invitation again with a new link (the previous link stops working) and a fresh 7-day expiry. */
export async function resendInvite(actor: Actor, inviteId: unknown, now = new Date()): Promise<InviteSendResult> {
  const orgId = orgOf(actor)
  return admin(async db => {
    await assertCan(actor, orgId, 'members.manage', db)
    const i = await openInvite(db, orgId, inviteId)
    if (i.status === 'revoked') await db.query(`update invites set revoked_at = null where id = $1`, [i.id])
    const out = await issue(db, actor, i.id, now)
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'members.invite_resent', actor: actor.label, detail: { invite_id: i.id, email_status: out.emailStatus } })
    return out
  })
}

/** Withdraw an invitation: its link stops working at once. */
export async function revokeInvite(actor: Actor, inviteId: unknown) {
  const orgId = orgOf(actor)
  return admin(async db => {
    await assertCan(actor, orgId, 'members.manage', db)
    const i = await openInvite(db, orgId, inviteId)
    await db.query(`update invites set status = 'revoked', revoked_at = now(), token_hash = null where id = $1`, [i.id])
    await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'members.invite_revoked', actor: actor.label, detail: { invite_id: i.id } })
    return { inviteId: i.id, revoked: true }
  })
}

export type AcceptResult = { orgId: string; orgName: string; role: InviteRole; appMetadata: 'recorded' | 'skipped' | 'failed' }

/**
 * Consume the invite for the signed-in person. Server code only: the organization and role come from the
 * invite row the signed token names, never from the request or from user metadata.
 */
export async function acceptInvite(session: Session, token: string, now = new Date()): Promise<AcceptResult> {
  const r = await admin(async db => {
    const i = await checkToken(db, token, now, true)
    if (session.role === 'staff') throw refuse('staff', i)
    if (session.email.trim().toLowerCase() !== i.email.toLowerCase()) throw refuse('wrong_email', i)
    const p = await db.one<{ agency_id: string | null }>('select agency_id from profiles where id = $1 for update', [session.uid])
    if (!p) throw refuse('invalid', i)
    if (p.agency_id === i.agency_id) throw refuse('already_member', i)
    if (p.agency_id) throw refuse('other_org', i)
    await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 5521))`, [`members:${i.agency_id}`])
    // the explicit org_role wins over the profiles_org_role trigger's derivation
    await db.query('update profiles set agency_id = $2, org_role = $3 where id = $1', [session.uid, i.agency_id, i.org_role])
    await db.query(`update invites set accepted_at = $2, status = 'accepted', accepted_by = $3, supabase_user_id = $3, token_hash = null where id = $1`, [i.id, now.toISOString(), session.uid])
    await audit(db, { orgId: i.agency_id, entityType: 'org', entityId: i.agency_id, event: 'members.joined', actor: `user:${session.email}`, detail: { invite_id: i.id, role: i.org_role } })
    return { orgId: i.agency_id, orgName: i.org_name, role: i.org_role }
  })
  const meta = await setAppMetadata(session.uid, { agency_id: r.orgId, role: 'client' })
  return { ...r, appMetadata: meta.ok ? 'recorded' : meta.skipped ? 'skipped' : 'failed' }
}
