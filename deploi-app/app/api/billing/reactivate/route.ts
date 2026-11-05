import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { assertCan } from '@/lib/platform/rbac'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { reactivateSubscription } from '@/lib/billing/lifecycle'

export const dynamic = 'force-dynamic'

/** Undo a cancellation before the period ends. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'Deploi staff cannot change a merchant subscription')
    await assertCan(actor, actor.orgId, 'billing')
    return NextResponse.json({ ok: true, ...(await admin(db => reactivateSubscription(db, { orgId: actor.orgId, actor: actor.label }))) })
  } catch (e) { return errorResponse(e) }
}
