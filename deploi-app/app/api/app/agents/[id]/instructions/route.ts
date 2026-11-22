import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { listInstructions, addInstruction } from '@/lib/app/contract'
import { agentIdParam } from '@/lib/app/request'

export const dynamic = 'force-dynamic'

/** The agent's standing instructions, in order. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    const id = agentIdParam((await ctx.params).id)
    return NextResponse.json({ ok: true, instructions: await listInstructions(actor, id) })
  } catch (e) { return errorResponse(e) }
}

/** { text (at most 500 characters), position? }. Owners and admins. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const id = agentIdParam((await ctx.params).id)
    const body = await readJson(req)
    return NextResponse.json({ ok: true, instruction: await addInstruction(actor, id, { text: body.text, position: body.position }) })
  } catch (e) { return errorResponse(e) }
}
