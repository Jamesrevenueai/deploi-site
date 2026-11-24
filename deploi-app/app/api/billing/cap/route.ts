import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { assertCan } from '@/lib/platform/rbac'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { setOverageCap, usageState } from '@/lib/metering'
import { pendingOverage } from '@/lib/billing/v2'
import { engineConfig } from '@/lib/engine/config'

export const dynamic = 'force-dynamic'

/** This month's metered usage: actions (and texts on Office), the included allowance, the overage cap and what is not charged yet. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'use the staff tools for a merchant\'s usage')
    const [usage, pending] = await admin(db => Promise.all([usageState(db, actor.orgId), pendingOverage(db, actor.orgId)]))
    return NextResponse.json({ ok: true, usage, pending, storeBillingRequired: engineConfig.billingRequired })
  } catch (e) { return errorResponse(e) }
}

/** { actionCapCents?, textCapCents? }: the most overage allowed per month (0 = stop at the allowance). Owners and admins. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'Deploi staff cannot change a merchant cap')
    await assertCan(actor, actor.orgId, 'billing')
    const body = await readJson(req)
    const num = (v: unknown) => (v === undefined ? undefined : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : (() => { throw new HttpError(400, 'invalid_input', 'caps are whole cents, 0 or more') })())
    await admin(db => setOverageCap(db, actor.orgId, { actionCapCents: num(body.actionCapCents), textCapCents: num(body.textCapCents), by: actor.label }))
    return NextResponse.json({ ok: true, usage: await admin(db => usageState(db, actor.orgId)) })
  } catch (e) { return errorResponse(e) }
}
