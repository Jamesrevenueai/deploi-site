import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { learned } from '@/lib/app/contract'

export const dynamic = 'force-dynamic'

/** What Deploi learned the last time it read the business (null when it never has). */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, learned: await learned(actor) })
  } catch (e) { return errorResponse(e) }
}
