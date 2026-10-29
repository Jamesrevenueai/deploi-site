import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { dismissInsight, handOffInsight } from '@/lib/competitors/handoff'

export const dynamic = 'force-dynamic'

/**
 * POST handoff { supplierAgentId, note? }: create a sourcing-request draft for a Supplier Chaser (never sent automatically).
 * POST dismiss: hide the finding.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id, action } = await ctx.params
    if (action === 'handoff') {
      const body = await readJson(req)
      const supplierAgentId = String(body.supplierAgentId ?? '')
      if (!/^[0-9a-f-]{36}$/i.test(supplierAgentId)) throw new HttpError(400, 'invalid_input', 'choose a Supplier Chaser')
      return NextResponse.json({ ok: true, ...(await handOffInsight(actor, id, { supplierAgentId, note: typeof body.note === 'string' ? body.note.slice(0, 1000) : null })) })
    }
    if (action === 'dismiss') { await dismissInsight(actor, id); return NextResponse.json({ ok: true }) }
    throw new HttpError(404, 'not_found', 'unknown action')
  } catch (e) { return errorResponse(e) }
}
