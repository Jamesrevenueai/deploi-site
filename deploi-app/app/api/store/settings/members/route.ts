import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { changeRole, inviteMember, listMembers, removeMember, resendInvite, revokeInvite, setApprovalPolicy } from '@/lib/platform/members'

export const dynamic = 'force-dynamic'

/** Members of the organization with their roles, open invites, your role and whether members may approve. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, ...(await listMembers(actor)) })
  } catch (e) { return errorResponse(e) }
}

/**
 * { action: 'change_role', userId, role } | { action: 'remove', userId } | { action: 'invite', email, role }
 * | { action: 'resend_invite', inviteId } (new link, the old one stops working) | { action: 'revoke_invite', inviteId }
 * | { action: 'set_approval_policy', membersCanApprove }. Owners and admins; owner changes and the approval
 * policy need an owner; the last owner is protected.
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    const userId = typeof body.userId === 'string' && /^[0-9a-f-]{36}$/i.test(body.userId) ? body.userId : null
    switch (body.action) {
      case 'change_role': if (!userId) throw new HttpError(400, 'invalid_input', 'userId is required'); return NextResponse.json({ ok: true, ...(await changeRole(actor, userId, body.role)) })
      case 'remove': if (!userId) throw new HttpError(400, 'invalid_input', 'userId is required'); return NextResponse.json({ ok: true, ...(await removeMember(actor, userId)) })
      case 'invite': return NextResponse.json({ ok: true, ...(await inviteMember(actor, body.email, body.role ?? 'member')) })
      case 'resend_invite': return NextResponse.json({ ok: true, ...(await resendInvite(actor, body.inviteId)) })
      case 'revoke_invite': return NextResponse.json({ ok: true, ...(await revokeInvite(actor, body.inviteId)) })
      case 'set_approval_policy': return NextResponse.json({ ok: true, ...(await setApprovalPolicy(actor, body.membersCanApprove)) })
      default: throw new HttpError(400, 'invalid_input', 'action must be change_role, remove, invite, resend_invite, revoke_invite or set_approval_policy')
    }
  } catch (e) { return errorResponse(e) }
}
