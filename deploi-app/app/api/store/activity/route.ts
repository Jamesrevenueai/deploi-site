import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { activity } from '@/lib/engine/queries'
import type { Outcome } from '@/lib/engine/outcomes'

export const dynamic = 'force-dynamic'

/** Executions with their outcome (pending / verified / failed / blocked), plus stale, expired and blocked proposals. ?outcome= */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const o = new URL(req.url).searchParams.get('outcome')
    const outcome = (['pending', 'verified', 'failed', 'blocked'] as Outcome[]).find(x => x === o)
    return NextResponse.json({ ok: true, ...(await activity(actor, { outcome })) })
  } catch (e) { return errorResponse(e) }
}
