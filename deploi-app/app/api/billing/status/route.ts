import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { billingMode } from '@/lib/billing/config'
import { billingOverview } from '@/lib/billing/overview'

export const dynamic = 'force-dynamic'

/** The in-app billing banner for the signed-in organization ({ banner: null } when there is nothing to say). */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff' || billingMode() === 'off') return NextResponse.json({ ok: true, banner: null })
    const o = await admin(db => billingOverview(db, actor.orgId))
    return NextResponse.json({ ok: true, banner: o.banner, status: o.billing.status, readOnly: o.billing.readOnly }, { headers: { 'cache-control': 'no-store' } })
  } catch (e) { return errorResponse(e) }
}
