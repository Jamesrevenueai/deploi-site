import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { assertNotEmbedded } from '@/lib/store/embedded-gate'
import { withActor } from '@/lib/engine/actor'
import { importPurchaseOrdersAs, listPos, PO_CSV_COLUMNS, PO_CSV_TEMPLATE } from '@/lib/commerce/purchase-orders'
import { afterPoImport } from '@/lib/commerce/supplier-coordinator'

export const dynamic = 'force-dynamic'

/** The organization's purchase orders (RLS), or the CSV template (?template=1). */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    if (url.searchParams.get('template')) return new NextResponse(PO_CSV_TEMPLATE, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="purchase-orders-template.csv"' } })
    const actor = await resolveActor(req)
    assertNotEmbedded(actor) // purchase orders (Supplier Coordinator) are not offered inside Shopify
    if (actor.kind === 'staff') throw new HttpError(400, 'invalid_input', 'open this from the organization')
    const pos = await withActor(actor, db => listPos(db, actor.orgId))
    const cases = await withActor(actor, db => db.query<{ id: string; ref: string; status: string; title: string; records: { type: string; id: string }[] }>(
      `select id, ref, status, title, records from cases where org_id = $1 and kind = 'supplier_exception' and status not in ('resolved','cancelled') order by updated_at desc limit 200`, [actor.orgId]))
    return NextResponse.json({ ok: true, purchaseOrders: pos, openCases: cases, columns: PO_CSV_COLUMNS })
  } catch (e) { return errorResponse(e) }
}

/**
 * Import a purchase-order file. Body { csv, connectionId? }. The file is data: every row is validated, a PO with
 * a bad row is not imported, the same rows again change nothing, and SKUs are matched to the store only when
 * unambiguous. Exceptions on the imported POs open cases.
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    assertNotEmbedded(actor)
    const body = await readJson(req)
    const csv = typeof body.csv === 'string' ? body.csv : ''
    if (!csv.trim()) throw new HttpError(400, 'invalid_input', 'the file is empty')
    if (csv.length > 2_000_000) throw new HttpError(413, 'too_large', 'files up to 2 MB')
    const r = await importPurchaseOrdersAs(actor, { csv, connectionId: typeof body.connectionId === 'string' && body.connectionId ? body.connectionId : null })
    const cases = actor.kind === 'staff' ? null : await afterPoImport(actor.orgId, r.poIds, actor.label)
    return NextResponse.json({ ok: true, result: { ...r, errors: r.errors.slice(0, 200) }, cases: cases ? { opened: cases.opened.length, redetected: cases.redetected.length } : null }, { status: r.created.length || r.updated.length || r.unchanged.length ? 200 : 400 })
  } catch (e) { return errorResponse(e) }
}
