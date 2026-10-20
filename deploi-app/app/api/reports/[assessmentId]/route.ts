import { NextResponse } from 'next/server'
import { getSession, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { getFile } from '@/lib/storage'
import { log } from '@/lib/log'

export const dynamic = 'force-dynamic'

/** Streams an assessment PDF. RLS decides who can see the row (staff, or the agency's own client). */
export async function GET(_req: Request, ctx: { params: Promise<{ assessmentId: string }> }) {
  const { assessmentId } = await ctx.params
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!/^[0-9a-f-]{36}$/i.test(assessmentId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const ip = await requestIp()
  const row = await withUser(session, async db => {
    const r = await db.one<{ id: string; agency_id: string; report_path: string | null; agency_name: string }>(
      'select a.id, a.agency_id, a.report_path, g.name as agency_name from assessments a join agencies g on g.id = a.agency_id where a.id = $1', [assessmentId])
    if (r) await db.auditRead('assessments', r.agency_id, [r.id])
    return r
  }, { ip })
  if (!row || !row.report_path) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    const bytes = await getFile(row.report_path)
    log.info('report.served', { assessment_id: row.id, bytes: bytes.length })
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="operations-assessment-${row.id.slice(0, 8)}.pdf"`,
        'cache-control': 'private, no-store',
      },
    })
  } catch (e) {
    log.error('report.read_failed', { assessment_id: row.id, error: (e as Error).message })
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
}
