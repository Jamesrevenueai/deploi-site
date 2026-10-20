'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireRole, requestIp } from '../auth'
import { withUser } from '../db'
import { inviteUser, resendInvite, revokeInvite } from './invite'
import type { Role } from '../session'

function back(agencyId: string, q: Record<string, string>) {
  redirect(`/staff/agencies/${agencyId}/users?${new URLSearchParams(q)}`)
}

export async function inviteUserAction(formData: FormData) {
  const session = await requireRole('staff')
  const agencyId = String(formData.get('agency_id') ?? '')
  const email = String(formData.get('email') ?? '')
  const role = (String(formData.get('role') ?? 'client') as Role)
  try {
    const r = await withUser(session, db => inviteUser(db, { agencyId, email, role, invitedBy: session.uid }), { ip: await requestIp() })
    revalidatePath(`/staff/agencies/${agencyId}/users`)
    back(agencyId, { ok: r.mocked ? 'recorded' : 'sent' })
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw e
    back(agencyId, { error: (e as Error).message })
  }
}

export async function resendInviteAction(formData: FormData) {
  const session = await requireRole('staff')
  const agencyId = String(formData.get('agency_id') ?? '')
  const id = String(formData.get('invite_id') ?? '')
  try {
    const r = await withUser(session, db => resendInvite(db, id), { ip: await requestIp() })
    revalidatePath(`/staff/agencies/${agencyId}/users`)
    back(agencyId, { ok: r.mocked ? 'recorded' : 'resent' })
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw e
    back(agencyId, { error: (e as Error).message })
  }
}

export async function revokeInviteAction(formData: FormData) {
  const session = await requireRole('staff')
  const agencyId = String(formData.get('agency_id') ?? '')
  const id = String(formData.get('invite_id') ?? '')
  try {
    await withUser(session, db => revokeInvite(db, id), { ip: await requestIp() })
    revalidatePath(`/staff/agencies/${agencyId}/users`)
    back(agencyId, { ok: 'revoked' })
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw e
    back(agencyId, { error: (e as Error).message })
  }
}
