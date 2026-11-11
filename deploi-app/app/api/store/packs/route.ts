import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { packsOverview, packWrite } from '@/lib/packs/dashboard'
import { chooseBusinessType, updatePackConfig } from '@/lib/packs/settings'

export const dynamic = 'force-dynamic'

/** The business type, the packs it turns on, and each pack's counts. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, ...(await packsOverview(actor)) })
  } catch (e) { return errorResponse(e) }
}

/**
 * Body { op }:
 *  business-type { businessType, trade? } · settings { patch } ·
 *  crew | vendor | property | listing | placement | payment | quote | schedule (the owner's records; see lib/packs/dashboard.ts)
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    let result: unknown
    if (body.op === 'business-type') result = await chooseBusinessType(actor, { businessType: body.businessType, trade: body.trade })
    else if (body.op === 'settings') result = await updatePackConfig(actor, (body.patch && typeof body.patch === 'object' ? body.patch : {}) as Record<string, unknown>)
    else result = await packWrite(actor, body.op, body)
    return NextResponse.json({ ok: true, result, ...(await packsOverview(actor)) })
  } catch (e) { return errorResponse(e) }
}
