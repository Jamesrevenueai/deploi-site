import { NextResponse } from 'next/server'
import { officeActor, officeError } from '@/lib/office/request'
import { officeWorkLog } from '@/lib/office/queries'

export const dynamic = 'force-dynamic'

/** Work log: every office action with its outcome, approval and permission version, and the audit events. */
export async function GET(req: Request) {
  try {
    const actor = await officeActor(req)
    return NextResponse.json({ ok: true, ...(await officeWorkLog(actor)) })
  } catch (e) { return officeError(e) }
}
