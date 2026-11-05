import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { downloadExport } from '@/lib/privacy/exports'

export const dynamic = 'force-dynamic'

/**
 * One customer data export, decrypted, for an owner or admin of its organization (the download is recorded).
 * ?format=file answers with the JSON file itself (a browser download); otherwise { filename, data }.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    const { id } = await params
    const r = await downloadExport(actor, id)
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    if (new URL(req.url).searchParams.get('format') === 'file') {
      return new NextResponse(r.json, { headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${r.filename}"` } })
    }
    return NextResponse.json({ ok: true, filename: r.filename, data: JSON.parse(r.json) }, { headers })
  } catch (e) { return errorResponse(e) }
}
