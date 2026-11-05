import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { withActor } from '@/lib/engine/actor'
import { listCases, caseCounts, type CaseView, type Suite } from '@/lib/cases'

export const dynamic = 'force-dynamic'
const VIEWS: CaseView[] = ['in_progress', 'needs_approval', 'completed', 'attention', 'all']

/** The organization's cases. ?view=in_progress|needs_approval|completed|attention|all&suite=commerce|office&kind=&before=<iso> */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') throw new HttpError(400, 'invalid_input', 'open this from the organization')
    const q = new URL(req.url).searchParams
    const view = (q.get('view') ?? 'all') as CaseView
    if (!VIEWS.includes(view)) throw new HttpError(400, 'invalid_input', 'unknown view')
    const suite = q.get('suite') === 'commerce' || q.get('suite') === 'office' ? (q.get('suite') as Suite) : undefined
    const out = await withActor(actor, async db => ({ cases: await listCases(db, actor.orgId, { view, suite, kind: q.get('kind') ?? undefined, before: q.get('before') ?? undefined, limit: Number(q.get('limit') ?? 50) }), counts: await caseCounts(db, actor.orgId) }))
    return NextResponse.json({ ok: true, ...out })
  } catch (e) { return errorResponse(e) }
}
