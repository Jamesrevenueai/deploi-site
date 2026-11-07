import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { finishTask } from '@/lib/app/contract'

export const dynamic = 'force-dynamic'

/** { op: "done" | "cancel" }: close a task you gave an agent. */
export async function POST(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    return NextResponse.json({ ok: true, task: await finishTask(actor, (await ctx.params).ref, body.op) })
  } catch (e) { return errorResponse(e) }
}
