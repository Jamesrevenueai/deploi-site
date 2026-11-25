import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { errorResponse, readJson, HttpError } from '@/lib/store/request'
import { requireStaffApi } from '@/lib/platform/staff'
import { editPlan, loadPlans, invalidatePlanCache, PlanEditError } from '@/lib/plans/catalog'

export const dynamic = 'force-dynamic'

/** Staff only: every plan with its status (hypothesis, approved, retired) and the recent changes. */
export async function GET(req: Request) {
  try {
    await requireStaffApi(req)
    invalidatePlanCache()
    const r = await admin(async db => ({ plans: await loadPlans(db), changes: await db.query('select plan_key, version, actor, at, change->\'patch\' as patch from plan_changes order by id desc limit 50') }))
    return NextResponse.json({ ok: true, ...r })
  } catch (e) { return errorResponse(e) }
}

/**
 * Staff only: { key, patch, create? } edits one plan (audited, version bumped). Approving a price needs an
 * owner e-mail in PRICING_APPROVER_EMAILS. Never changes an existing subscription.
 */
export async function POST(req: Request) {
  try {
    const actor = await requireStaffApi(req, { mutating: true })
    const body = await readJson(req)
    if (typeof body.key !== 'string' || !body.patch || typeof body.patch !== 'object') throw new HttpError(400, 'invalid_input', 'key and patch are required')
    const plan = await admin(db => editPlan(db, { key: body.key as string, patch: body.patch as Record<string, unknown>, staffEmail: actor.session.email, create: body.create === true }))
    return NextResponse.json({ ok: true, plan })
  } catch (e) {
    if (e instanceof PlanEditError) return NextResponse.json({ ok: false, error: e.code, message: e.message }, { status: e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 400 })
    return errorResponse(e)
  }
}
