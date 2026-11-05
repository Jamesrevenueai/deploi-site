import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { admin } from '@/lib/db'
import { assertMerchant, withActor } from '@/lib/engine/actor'
import { loadPo, recordReceipt } from '@/lib/commerce/purchase-orders'
import { listResolutions, recheckPo } from '@/lib/commerce/supplier-coordinator'

export const dynamic = 'force-dynamic'

/** One purchase order with its cases and the resolution options waiting for a decision (RLS: own organization only). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') throw new HttpError(400, 'invalid_input', 'open this from the organization')
    const { id } = await params
    const r = await withActor(actor, async db => {
      const po = await loadPo(db, id, actor.orgId)
      if (!po) return null
      const cases = await db.query(`select c.id, c.ref, c.status, c.status_reason, c.title, c.next_action from case_links l join cases c on c.id = l.case_id
        where l.org_id = $1 and l.ref_type = 'purchase_order' and l.ref_id = $2 order by c.opened_at desc`, [actor.orgId, po.id])
      const options = (await listResolutions(db, actor.orgId, { status: 'proposed' })).filter(o => o.po_id === po.id)
      return { po, cases, options }
    })
    if (!r) throw new HttpError(404, 'not_found', 'purchase order not found')
    return NextResponse.json({ ok: true, ...r })
  } catch (e) { return errorResponse(e) }
}

/** Record goods received. Body { op: 'receive', lines: [{ sku, qty }] }. Open cases on the PO are checked again at once. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id } = await params
    const body = await readJson(req)
    if (body.op !== 'receive') throw new HttpError(400, 'invalid_input', 'op must be receive')
    const visible = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from purchase_orders where id = $1', [id]))
    if (!visible) throw new HttpError(404, 'not_found', 'purchase order not found')
    assertMerchant(actor, visible.org_id)
    const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 500).map(l => ({ sku: String((l as Record<string, unknown>)?.sku ?? ''), qty: Number((l as Record<string, unknown>)?.qty) }))
    const po = await admin(db => recordReceipt(db, { orgId: visible.org_id, poId: visible.id, lines, actor: actor.label }))
    const cases = await recheckPo(visible.org_id, visible.id)
    return NextResponse.json({ ok: true, po, cases })
  } catch (e) { return errorResponse(e) }
}
