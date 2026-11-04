import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { env } from '@/lib/env'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { createPortalSession } from '@/lib/billing/checkout'

export const dynamic = 'force-dynamic'

/** Open the Stripe customer portal (change plan, payment method, cancel). Returns { url }. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'Deploi staff cannot manage a merchant subscription')
    return NextResponse.json({ ok: true, ...(await admin(db => createPortalSession(db, { orgId: actor.orgId, actor: actor.label, appUrl: env.appUrl }))) })
  } catch (e) { return errorResponse(e) }
}
