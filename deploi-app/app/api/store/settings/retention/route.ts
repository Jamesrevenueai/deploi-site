import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { retentionFor, setRetention } from '@/lib/platform/retention'

export const dynamic = 'force-dynamic'

/** How long each kind of data is kept for this organization (defaults and its own adjustments). */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, ...(await retentionFor(actor)) })
  } catch (e) { return errorResponse(e) }
}

/** { emailBodies?, inboundRaw?, jobs? }: days (1..730) or null for the default. Owners and admins. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    return NextResponse.json({ ok: true, ...(await setRetention(actor, await readJson(req))) })
  } catch (e) { return errorResponse(e) }
}
