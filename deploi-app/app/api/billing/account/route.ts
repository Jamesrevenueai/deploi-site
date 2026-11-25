import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { assertCan } from '@/lib/platform/rbac'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { stripeAccount } from '@/lib/billing/lifecycle'

export const dynamic = 'force-dynamic'

/** Invoices (with Stripe's hosted invoice links) and the payment method summary, read from Stripe. Owners and admins. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'Deploi staff cannot read a merchant\'s payment details')
    await assertCan(actor, actor.orgId, 'billing')
    return NextResponse.json({ ok: true, ...(await admin(db => stripeAccount(db, actor.orgId))) }, { headers: { 'cache-control': 'no-store' } })
  } catch (e) { return errorResponse(e) }
}
