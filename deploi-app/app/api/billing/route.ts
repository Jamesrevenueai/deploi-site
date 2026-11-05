import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { billingMode } from '@/lib/billing/config'
import { billingOverview } from '@/lib/billing/overview'
import { LIBRARY } from '@/lib/library/config'

export const dynamic = 'force-dynamic'

/**
 * The organization's billing: mode, who bills it (Stripe or Shopify), subscription and trial state, open
 * payment failures, the plans on offer (prices from the plans table, labelled "Pilot pricing" while they are
 * hypotheses), usage against the allowance (actions, emails, AI spend) and the in-app banner. Invoices and the
 * payment method come from /api/billing/account (Stripe).
 */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') return NextResponse.json({ ok: true, mode: billingMode(), staff: true })
    const o = await admin(db => billingOverview(db, actor.orgId))
    return NextResponse.json({ ok: true, ...o, pricingStatus: LIBRARY.pricingStatus }, { headers: { 'cache-control': 'no-store' } })
  } catch (e) { return errorResponse(e) }
}
