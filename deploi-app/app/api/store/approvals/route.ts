import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { listPendingApprovals, approvalSources } from '@/lib/approvals'

export const dynamic = 'force-dynamic'

/**
 * Everything waiting on the organization, from every source, newest first, with the exact content each
 * decision covers (emails: sender, recipients, subject, body; store changes: field from -> to and the
 * evidence) and the `version` a decision must carry. ?source= narrows to one source.
 */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const q = new URL(req.url).searchParams
    const r = await listPendingApprovals(actor, { source: q.get('source'), orgId: actor.kind === 'staff' ? q.get('orgId') ?? undefined : undefined })
    return NextResponse.json({ ok: true, sources: approvalSources(), ...r })
  } catch (e) { return errorResponse(e) }
}
