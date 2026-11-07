import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { delegateTask } from '@/lib/app/contract'
import { agentIdParam } from '@/lib/app/request'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** { text (at most 500 characters) }: give this agent a task. Returns the task (its case reference) and the agent's answer. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const id = agentIdParam((await ctx.params).id)
    const body = await readJson(req)
    return NextResponse.json({ ok: true, task: await delegateTask(actor, id, body.text) })
  } catch (e) { return errorResponse(e) }
}
