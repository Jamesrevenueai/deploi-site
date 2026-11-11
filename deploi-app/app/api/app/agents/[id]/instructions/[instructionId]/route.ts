import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { updateInstruction, deleteInstruction } from '@/lib/app/contract'
import { agentIdParam } from '@/lib/app/request'

export const dynamic = 'force-dynamic'

/** { text?, position? }. Owners and admins. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; instructionId: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const p = await ctx.params
    const body = await readJson(req)
    return NextResponse.json({ ok: true, instruction: await updateInstruction(actor, agentIdParam(p.id), p.instructionId, { text: body.text, position: body.position }) })
  } catch (e) { return errorResponse(e) }
}

/** Owners and admins. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; instructionId: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const p = await ctx.params
    return NextResponse.json({ ok: true, ...(await deleteInstruction(actor, agentIdParam(p.id), p.instructionId)) })
  } catch (e) { return errorResponse(e) }
}
