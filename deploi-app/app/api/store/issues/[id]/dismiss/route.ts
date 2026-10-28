import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, ipOf } from '@/lib/store/request'
import { dismissIssue } from '@/lib/engine/review'

/** Acknowledge an issue; it stays closed until the problem goes away and comes back. Body: { note? } */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id } = await ctx.params
    const body = await readJson(req)
    await dismissIssue(actor, id, String(body.note ?? '').slice(0, 500), { ip: ipOf(req) })
    return NextResponse.json({ ok: true })
  } catch (e) { return errorResponse(e) }
}
