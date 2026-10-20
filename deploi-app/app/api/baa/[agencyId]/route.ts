import { NextResponse } from 'next/server'
import { getSession, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { getFile } from '@/lib/storage'
import { log } from '@/lib/log'

export const dynamic = 'force-dynamic'

/** Streams the signed BAA. RLS decides who sees the agency row (staff, or that agency's client). */
export async function GET(_req: Request, ctx: { params: Promise<{ agencyId: string }> }) {
  const { agencyId } = await ctx.params
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!/^[0-9a-f-]{36}$/i.test(agencyId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const ip = await requestIp()
  const row = await withUser(session, async db => {
    const r = await db.one<{ id: string; baa_document_url: string | null }>('select id, baa_document_url from agencies where id = $1', [agencyId])
    if (r) await db.auditRead('agencies', r.id, [r.id])
    return r
  }, { ip })
  if (!row?.baa_document_url) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    const bytes = await getFile(row.baa_document_url)
    log.info('baa.served', { agency_id: row.id, bytes: bytes.length })
    return new NextResponse(new Uint8Array(bytes), {
      headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="baa-${row.id.slice(0, 8)}.pdf"`, 'cache-control': 'private, no-store' },
    })
  } catch (e) {
    log.error('baa.read_failed', { agency_id: row.id, error: (e as Error).message })
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
}
