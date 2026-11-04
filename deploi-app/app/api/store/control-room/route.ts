import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { controlRoom } from '@/lib/store/control-room'

export const dynamic = 'force-dynamic'

/** Everything the owner needs at a glance, for their organization only (runs as the user, under RLS). */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, canAct: actor.kind !== 'staff', ...(await controlRoom(actor)) })
  } catch (e) { return errorResponse(e) }
}
