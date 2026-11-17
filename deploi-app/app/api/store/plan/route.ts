import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { assertNotEmbedded } from '@/lib/store/embedded-gate'
import { LIBRARY } from '@/lib/library/config'
import { usageSummary } from '@/lib/library/usage'
import { setTier } from '@/lib/library/switches'
import { allTierEconomics, DEFAULT_MODEL } from '@/lib/library/pricing'

export const dynamic = 'force-dynamic'

/** The merchant's plan: tier, this month's usage against the allowance, and the tiers. Staff also get the proposed economics. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    assertNotEmbedded(actor) // library tiers are not shown inside Shopify: Shopify merchants change plans on Shopify's plan page
    if (actor.kind === 'staff') return NextResponse.json({ ok: true, tiers: LIBRARY.tiers, pricingStatus: LIBRARY.pricingStatus, economics: allTierEconomics(DEFAULT_MODEL), model: DEFAULT_MODEL })
    return NextResponse.json({ ok: true, tiers: LIBRARY.tiers, pricingStatus: LIBRARY.pricingStatus, usage: await usageSummary(actor, actor.orgId) })
  } catch (e) { return errorResponse(e) }
}

/** { tier }: choose the plan to trial. Private beta: nothing is charged; a downgrade switches off agents the new tier does not include. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    assertNotEmbedded(actor)
    const body = await readJson(req)
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'Deploi staff cannot change a merchant plan')
    if ((await import('@/lib/billing/config')).billingMode() !== 'off') throw new HttpError(409, 'use_billing', 'with billing on, the plan follows the subscription: change it on the billing page') // SECURITY-REVIEW F-09
    return NextResponse.json({ ok: true, ...(await setTier(actor, body.tier)) })
  } catch (e) { return errorResponse(e) }
}
