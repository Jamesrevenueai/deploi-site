'use server'
import { revalidatePath } from 'next/cache'
import { requireRole } from '@/lib/auth'
import { admin } from '@/lib/db'
import { createInvite, decideAccess, revokeInvite } from '@/lib/engine/access'

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim()
const UUID = /^[0-9a-f-]{36}$/i

export async function decideAccessAction(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  const decision = str(formData, 'decision')
  if (!UUID.test(id) || !['approved', 'denied', 'clear'].includes(decision)) return
  await admin(db => decideAccess(db, id, decision as 'approved' | 'denied' | 'clear', str(formData, 'reason'), `staff:${session.email}`))
  revalidatePath('/staff/store-access')
}

export type InviteState = { code?: string; label?: string; error?: string }

/** Returns the plain code once, to this page only; it is stored only as a hash. */
export async function createInviteAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const session = await requireRole('staff')
  try {
    const r = await admin(db => createInvite(db, {
      label: str(formData, 'label'), shopDomain: str(formData, 'shop') || null,
      days: Number(str(formData, 'days') || 30), maxUses: Number(str(formData, 'max_uses') || 1),
    }, `staff:${session.email}`))
    revalidatePath('/staff/store-access')
    return { code: r.code, label: r.invite.label }
  } catch (e) { return { error: (e as Error).message } }
}

export async function revokeInviteAction(formData: FormData) {
  const session = await requireRole('staff')
  const id = str(formData, 'id')
  if (!UUID.test(id)) return
  await admin(db => revokeInvite(db, id, `staff:${session.email}`))
  revalidatePath('/staff/store-access')
}
