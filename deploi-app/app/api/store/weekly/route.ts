import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { weeklyPreview } from '@/lib/agents/weekly'

export const dynamic = 'force-dynamic'

/** This week's summary as it stands now (computed live; the email itself is sent by the weekly cron). */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'the weekly summary belongs to a merchant organization')
    return NextResponse.json({ ok: true, ...(await weeklyPreview(actor, actor.orgId)) })
  } catch (e) { return errorResponse(e) }
}
