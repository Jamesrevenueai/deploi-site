import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { env } from '@/lib/env'
import { assertCan } from '@/lib/platform/rbac'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { createCheckoutSession } from '@/lib/billing/checkout'
import { requireAgreements } from '@/lib/legal'
import { hasProduct } from '@/lib/products'

export const dynamic = 'force-dynamic'

/** { plan }: start a Stripe Checkout Session for the organization (not for Shopify-billed stores). Returns { url }. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    if (actor.kind !== 'staff') await assertCan(actor, actor.orgId, 'billing') // owners and admins only (F-08)
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'Deploi staff cannot start billing for a merchant')
    const body = await readJson(req)
    const office = await admin(async db => !(await hasProduct(db, actor.orgId, 'commerce')) && hasProduct(db, actor.orgId, 'office'))
    await requireAgreements(actor, office ? 'office' : 'commerce')
    const email = actor.kind === 'profile' ? actor.session.email : null
    const r = await admin(db => createCheckoutSession(db, { orgId: actor.orgId, plan: body.plan, email, actor: actor.label, appUrl: env.appUrl }))
    return NextResponse.json({ ok: true, ...r })
  } catch (e) { return errorResponse(e) }
}
