import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { assertCan } from '@/lib/platform/rbac'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { cancelSubscription } from '@/lib/billing/lifecycle'

export const dynamic = 'force-dynamic'

/** { reason, comment? }: cancel at the end of the current period. Data is kept; after the end the account is read-only. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'Deploi staff cannot cancel a merchant subscription')
    await assertCan(actor, actor.orgId, 'billing')
    const body = await readJson(req)
    return NextResponse.json({ ok: true, ...(await admin(db => cancelSubscription(db, { orgId: actor.orgId, reason: body.reason, comment: body.comment, actor: actor.label }))) })
  } catch (e) { return errorResponse(e) }
}
