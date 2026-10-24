import { NextResponse } from 'next/server'
import { getSession, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { getEngagement } from '@/lib/engagements/queries'
import { renderProposal } from '@/lib/report/proposal-pdf'
import { log } from '@/lib/log'

export const dynamic = 'force-dynamic'

/** Renders the proposal (commercial scope summary) for one engagement. Staff only. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (session.role !== 'staff') return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const e = await withUser(session, db => getEngagement(db, id), { ip: await requestIp() })
  if (!e) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    const bytes = await renderProposal(e)
    log.info('proposal.rendered', { engagement_id: e.id, bytes: bytes.length })
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="proposal-${e.id.slice(0, 8)}.pdf"`,
        'cache-control': 'private, no-store',
      },
    })
  } catch (err) {
    log.error('proposal.render_failed', { engagement_id: e.id, error: (err as Error).message })
    return NextResponse.json({ error: 'render failed' }, { status: 500 })
  }
}
