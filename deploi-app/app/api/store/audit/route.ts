import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { auditTrail } from '@/lib/engine/queries'

export const dynamic = 'force-dynamic'

/** The organization's audit trail, newest first. ?limit= (max 1000) */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const limit = Number(new URL(req.url).searchParams.get('limit') ?? 200) || 200
    return NextResponse.json({ ok: true, events: await auditTrail(actor, limit) })
  } catch (e) { return errorResponse(e) }
}
