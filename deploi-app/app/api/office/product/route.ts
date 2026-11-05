import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { enableProduct, hasProduct } from '@/lib/products'
import { officeActor, officeError } from '@/lib/office/request'
import { officeAudit } from '@/lib/office/audit'
import { disableOffice } from '@/lib/office/product'
import { readJson } from '@/lib/store/request'

export const dynamic = 'force-dynamic'

/** Whether Deploi Office is enabled for the signed-in customer's organization. */
export async function GET(req: Request) {
  try {
    const actor = await officeActor(req, { allowDisabled: true })
    return NextResponse.json({ ok: true, enabled: await admin(db => hasProduct(db, actor.orgId, 'office')) })
  } catch (e) { return officeError(e) }
}

/**
 * Body { enable: true }: turn Office on (a member may; enabling grants no agent anything).
 * Body { enable: false }: turn Office off (owner or admin): every Office agent is paused and its queued sends,
 * bookings and CRM writes are cancelled first, so nothing keeps acting; connections and history are kept.
 */
export async function POST(req: Request) {
  try {
    const actor = await officeActor(req, { mutating: true, allowDisabled: true })
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>))
    if (body.enable === false) return NextResponse.json({ ok: true, enabled: false, ...(await disableOffice(actor)) })
    await admin(async db => {
      await enableProduct(db, actor.orgId, 'office', actor.label)
      await officeAudit(db, { orgId: actor.orgId, entityType: 'office_agent', event: 'product.enabled', actor: actor.label })
    })
    return NextResponse.json({ ok: true, enabled: true })
  } catch (e) { return officeError(e) }
}
