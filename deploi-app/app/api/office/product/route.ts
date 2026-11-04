import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { enableProduct, hasProduct } from '@/lib/products'
import { officeActor, officeError } from '@/lib/office/request'
import { officeAudit } from '@/lib/office/audit'

export const dynamic = 'force-dynamic'

/** Whether Deploi Office is enabled for the signed-in customer's organization. */
export async function GET(req: Request) {
  try {
    const actor = await officeActor(req, { allowDisabled: true })
    return NextResponse.json({ ok: true, enabled: await admin(db => hasProduct(db, actor.orgId, 'office')) })
  } catch (e) { return officeError(e) }
}

/** Body { enable: true }: a member of the organization turns Office on for it. Enabling grants no agent anything. */
export async function POST(req: Request) {
  try {
    const actor = await officeActor(req, { mutating: true, allowDisabled: true })
    await admin(async db => {
      await enableProduct(db, actor.orgId, 'office', actor.label)
      await officeAudit(db, { orgId: actor.orgId, entityType: 'office_agent', event: 'product.enabled', actor: actor.label })
    })
    return NextResponse.json({ ok: true, enabled: true })
  } catch (e) { return officeError(e) }
}
