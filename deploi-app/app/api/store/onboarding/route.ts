import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import {
  autoSetupAgents, chooseProducts, completeOnboarding, completeWizard, firstScan, onboardingView, saveBusiness, setAgreements, skipAgents, skipDiscovery, wizardView,
} from '@/lib/library/onboarding'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** The setup wizard's state (`wizard`) next to the agent library's onboarding view (kept for the team screens). */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const [legacy, wizard] = await Promise.all([onboardingView(actor), wizardView(actor)])
    return NextResponse.json({ ok: true, ...legacy, wizard })
  } catch (e) { return errorResponse(e) }
}

/**
 * Body { op }:
 *  business { name, timezone } · products { commerce, office, platform? } · agreements { status: 'satisfied' | 'skipped' }
 *  agents: create the recommended agents at drafts only (idempotent; each waits for the owner's grant)
 *  agents-skip · scan: the first read of the store (writes nothing to it) · discover-skip · complete
 *  (agreements, agents and scan are kept for older clients; the setup reads agreements from the acceptances
 *  and sets the team up through discovery)
 * Without op: marks the agent library's onboarding complete (store connected and plan chosen).
 * Every op returns the updated wizard state.
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    if (body.op === undefined) return NextResponse.json({ ok: true, ...(await completeOnboarding(actor)) })
    let result: unknown
    switch (body.op) {
      case 'business': result = await saveBusiness(actor, { name: body.name, timezone: body.timezone }); break
      case 'products': result = await chooseProducts(actor, { commerce: body.commerce, office: body.office, platform: body.platform }); break
      case 'agreements': result = await setAgreements(actor, body.status); break
      case 'agents': result = await autoSetupAgents(actor); break
      case 'agents-skip': result = await skipAgents(actor); break
      case 'scan': result = await firstScan(actor); break
      case 'discover-skip': result = await skipDiscovery(actor); break
      case 'complete': result = await completeWizard(actor); break
      default: throw new HttpError(400, 'invalid_input', 'unknown step')
    }
    return NextResponse.json({ ok: true, result, wizard: await wizardView(actor) })
  } catch (e) { return errorResponse(e) }
}
