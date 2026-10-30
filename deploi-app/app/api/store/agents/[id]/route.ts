import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { agentDetail } from '@/lib/agents/queries'
import { editAgent, deleteAgent } from '@/lib/agents/lifecycle'

export const dynamic = 'force-dynamic'

/** Agent, its authorization versions, runs, executions (before/after, qualification), waiting changes and items for a person. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    const { id } = await ctx.params
    return NextResponse.json({ ok: true, ...(await agentDetail(actor, id)) })
  } catch (e) { return errorResponse(e) }
}

/** Edit. Body { name?, taskText?, policy }. Narrowing applies at once; any expansion waits for a new grant. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id } = await ctx.params
    const body = await readJson(req)
    const r = await editAgent(actor, id, { name: typeof body.name === 'string' ? body.name : undefined, taskText: typeof body.taskText === 'string' ? body.taskText : undefined, policy: body.policy })
    return NextResponse.json({ ok: true, ...r })
  } catch (e) { return errorResponse(e) }
}

/** Delete: revokes the authorization, cancels queued writes, keeps the history. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id } = await ctx.params
    return NextResponse.json({ ok: true, ...(await deleteAgent(actor, id)) })
  } catch (e) { return errorResponse(e) }
}
