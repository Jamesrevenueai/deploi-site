import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { teamView } from '@/lib/library/switches'

export const dynamic = 'force-dynamic'

/** The team: every library agent with its tier lock, switch, permission, grants, counts; usage; custom agents; onboarding state. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, ...(await teamView(actor)) })
  } catch (e) { return errorResponse(e) }
}
