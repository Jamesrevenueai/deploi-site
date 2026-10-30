import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { LIBRARY } from '@/lib/library/config'
import { usageSummary } from '@/lib/library/usage'
import { setTier } from '@/lib/library/switches'
import { allTierEconomics, DEFAULT_MODEL } from '@/lib/library/pricing'

export const dynamic = 'force-dynamic'

/** The merchant's plan: tier, this month's usage against the allowance, and the tiers. Staff also get the proposed economics. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') return NextResponse.json({ ok: true, tiers: LIBRARY.tiers, pricingStatus: LIBRARY.pricingStatus, economics: allTierEconomics(DEFAULT_MODEL), model: DEFAULT_MODEL })
    return NextResponse.json({ ok: true, tiers: LIBRARY.tiers, pricingStatus: LIBRARY.pricingStatus, usage: await usageSummary(actor, actor.orgId) })
  } catch (e) { return errorResponse(e) }
}

/** { tier }: choose the plan to trial. Private beta: nothing is charged; a downgrade switches off agents the new tier does not include. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'Deploi staff cannot change a merchant plan')
    return NextResponse.json({ ok: true, ...(await setTier(actor, body.tier)) })
  } catch (e) { return errorResponse(e) }
}
