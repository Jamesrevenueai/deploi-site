import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { integrations } from '@/lib/store/control-room'

export const dynamic = 'force-dynamic'

/** Every integration with its honest status, what it is used for and the permissions it grants. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, integrations: await integrations(actor) })
  } catch (e) { return errorResponse(e) }
}
