import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { assertCan } from '@/lib/platform/rbac'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { cancelPendingChange, confirmPlanChange, previewPlanChange } from '@/lib/billing/lifecycle'

export const dynamic = 'force-dynamic'

/**
 * Change plan. { action: 'preview', plan } returns Stripe's preview (and a changeId); { action: 'confirm', changeId }
 * upgrades now (prorated) or schedules a downgrade at period end; { action: 'cancel_pending' } drops a scheduled
 * downgrade. The new plan's limits apply when Stripe confirms (webhook), not on this request.
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'Deploi staff cannot change a merchant subscription')
    await assertCan(actor, actor.orgId, 'billing')
    const body = await readJson(req)
    if (body.action === 'preview') return NextResponse.json({ ok: true, preview: await admin(db => previewPlanChange(db, { orgId: actor.orgId, planKey: body.plan, actor: actor.label })) })
    if (body.action === 'confirm') return NextResponse.json({ ok: true, ...(await admin(db => confirmPlanChange(db, { orgId: actor.orgId, changeId: body.changeId, actor: actor.label }))) })
    if (body.action === 'cancel_pending') return NextResponse.json({ ok: true, ...(await admin(db => cancelPendingChange(db, { orgId: actor.orgId, actor: actor.label }))) })
    throw new HttpError(400, 'invalid_input', 'action must be preview, confirm or cancel_pending')
  } catch (e) { return errorResponse(e) }
}
