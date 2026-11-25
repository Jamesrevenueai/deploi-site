import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { privacyView } from '@/lib/privacy/exports'

export const dynamic = 'force-dynamic'

/** Shopify customer privacy requests for this organization and the exports waiting to be downloaded (owners and admins; hashes and counts only). */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, ...(await privacyView(actor)) })
  } catch (e) { return errorResponse(e) }
}
