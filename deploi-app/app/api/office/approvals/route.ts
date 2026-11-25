import { NextResponse } from 'next/server'
import { officeActor, officeError } from '@/lib/office/request'
import { officeApprovals } from '@/lib/office/queries'

export const dynamic = 'force-dynamic'

/** Items waiting for approval (exact email text, event details or CRM change) and drafts. */
export async function GET(req: Request) {
  try {
    const actor = await officeActor(req)
    return NextResponse.json({ ok: true, ...(await officeApprovals(actor)) })
  } catch (e) { return officeError(e) }
}
