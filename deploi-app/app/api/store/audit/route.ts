import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { auditCsv, parseAuditFilters, searchAudit, verifyOwnAuditChain } from '@/lib/engine/audit-query'

export const dynamic = 'force-dynamic'

/**
 * The organization's audit trail, newest first.
 *   ?entityType= &event= (prefix) &actor= &agentId= &entityId= &from= &to= (ISO) &beforeId= &limit= (max 5000)
 *   ?format=csv   CSV download of the same rows (merchant users of the organization only)
 *   ?verify=1     also verify the organization's tamper-evident hash chain
 */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const q = new URL(req.url).searchParams
    const filters = parseAuditFilters(q)
    if (q.get('format') === 'csv') {
      if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'the export is for the organization\'s own users; staff use the audit viewer')
      const rows = await searchAudit(actor, { ...filters, limit: Math.min(filters.limit ?? 5000, 5000) })
      return new NextResponse(auditCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="deploi-audit-${new Date().toISOString().slice(0, 10)}.csv"`, 'cache-control': 'no-store' } })
    }
    const events = await searchAudit(actor, filters)
    const chain = q.get('verify') === '1' && actor.kind !== 'staff' ? await verifyOwnAuditChain(actor) : undefined
    return NextResponse.json({ ok: true, events, ...(chain ? { chain } : {}) })
  } catch (e) { return errorResponse(e) }
}
