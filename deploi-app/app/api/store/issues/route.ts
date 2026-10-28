import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { listIssues } from '@/lib/engine/queries'

export const dynamic = 'force-dynamic'

/** Issues for the actor's organization. ?status=live|resolved|all &kind=correctable|needs_person &connection=<id> */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const u = new URL(req.url)
    const status = (['live', 'resolved', 'all'] as const).find(s => s === u.searchParams.get('status')) ?? 'live'
    const kind = ['correctable', 'needs_person'].includes(u.searchParams.get('kind') ?? '') ? u.searchParams.get('kind')! : undefined
    const issues = await listIssues(actor, { status, kind, connectionId: u.searchParams.get('connection') ?? undefined })
    return NextResponse.json({ ok: true, issues })
  } catch (e) { return errorResponse(e) }
}
