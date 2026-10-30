import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { assertMerchant, withActor } from '@/lib/engine/actor'
import { listReferences } from '@/lib/agents/queries'
import { saveReference, templateCsv, REFERENCE_TEMPLATES, type ReferenceKind } from '@/lib/agents/references'

export const dynamic = 'force-dynamic'
const KINDS = Object.keys(REFERENCE_TEMPLATES) as ReferenceKind[]

/** Reference files (?connection=<id>), or a CSV template (?template=price_list|sku_mapping|publication_list). */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const template = url.searchParams.get('template')
    if (template) {
      if (!KINDS.includes(template as ReferenceKind)) throw new HttpError(400, 'invalid_input', 'unknown template')
      return new NextResponse(templateCsv(template as ReferenceKind), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${template}-template.csv"` } })
    }
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, references: await listReferences(actor, url.searchParams.get('connection')), templates: REFERENCE_TEMPLATES })
  } catch (e) { return errorResponse(e) }
}

/**
 * Upload. Body { connectionId, kind, name, csv }. The file is data only: recognised columns are parsed,
 * everything else is ignored, and nothing in it can change what an agent is allowed to do.
 * The same name again creates a new version, which makes proposals based on the old one stale.
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    const kind = String(body.kind ?? '') as ReferenceKind
    if (!KINDS.includes(kind)) throw new HttpError(400, 'invalid_input', 'kind must be price_list, sku_mapping or publication_list')
    const csv = typeof body.csv === 'string' ? body.csv : ''
    if (!csv.trim()) throw new HttpError(400, 'invalid_input', 'the file is empty')
    if (csv.length > 5_000_000) throw new HttpError(413, 'too_large', 'files up to 5 MB')
    const conn = await withActor(actor, db => db.one<{ id: string; org_id: string; status: string }>('select id, org_id, status from store_connections where id = $1', [String(body.connectionId ?? '')]))
    if (!conn) throw new HttpError(404, 'not_found', 'store not found')
    assertMerchant(actor, conn.org_id)
    const r = await admin(db => saveReference(db, { orgId: conn.org_id, connectionId: conn.id, kind, name: String(body.name ?? ''), csv, actor: actor.label }))
    if (!r.ok) return NextResponse.json({ ok: false, error: 'invalid_file', message: r.errors.map(e => e.message).join('; '), errors: r.errors }, { status: 400 })
    return NextResponse.json({ ok: true, source: r.source, unchanged: r.unchanged, rowErrors: r.errors.slice(0, 50) })
  } catch (e) { return errorResponse(e) }
}
