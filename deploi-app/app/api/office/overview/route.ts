import { NextResponse } from 'next/server'
import { officeActor, officeError } from '@/lib/office/request'
import { officeOverview } from '@/lib/office/queries'

export const dynamic = 'force-dynamic'

/** Leads in follow-up, meetings booked, items waiting for approval and recent actions. 403 when Office is not enabled. */
export async function GET(req: Request) {
  try {
    const actor = await officeActor(req)
    return NextResponse.json({ ok: true, ...(await officeOverview(actor)) })
  } catch (e) { return officeError(e) }
}
