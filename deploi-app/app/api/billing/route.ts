import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { orgEntitlements } from '@/lib/plans/entitlements'
import { billingMode, priceIdFor, stripeConfig } from '@/lib/billing/config'
import { LIBRARY, TIER_KEYS } from '@/lib/library/config'

export const dynamic = 'force-dynamic'

/**
 * The organization's billing: mode, who bills it (Stripe or Shopify), subscription state, read-only
 * reason, and its plan limits. Prices are never invented here: amounts live in Stripe (and on its
 * checkout page); the library's proposed prices are labelled as proposals while pricing is unpublished.
 */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') return NextResponse.json({ ok: true, mode: billingMode(), staff: true })
    const e = await admin(db => orgEntitlements(db, actor.orgId))
    const portal = await admin(db => db.one<{ id: string }>('select id from billing_customers where org_id = $1', [actor.orgId]))
    return NextResponse.json({
      ok: true,
      mode: billingMode(),
      configured: stripeConfig.configured,
      billing: e.billing,
      plan: { tier: e.tier, label: e.label, priced: e.priced, writesAllowed: e.writesAllowed,
        limits: { maxAgents: e.maxAgents, maxCompetitorStores: e.maxCompetitorStores, monthlyActions: e.monthlyActions, monthlyEmails: e.monthlyEmails, officeSeats: e.officeSeats, officeConnections: e.officeConnections } },
      plans: TIER_KEYS.map(k => ({ key: k, name: LIBRARY.tiers.find(t => t.key === k)?.name ?? k, available: Boolean(priceIdFor(k)) })),
      pricingStatus: LIBRARY.pricingStatus,
      hasPortal: Boolean(portal),
    })
  } catch (e) { return errorResponse(e) }
}
