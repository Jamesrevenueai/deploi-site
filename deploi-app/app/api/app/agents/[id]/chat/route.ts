import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { chat, chatHistory } from '@/lib/app/contract'
import { agentIdParam } from '@/lib/app/request'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** The conversation with this agent, oldest first. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    const id = agentIdParam((await ctx.params).id)
    return NextResponse.json({ ok: true, messages: await chatHistory(actor, id) })
  } catch (e) { return errorResponse(e) }
}

/** { text }: rules-only answer (AI is off) from real data. Returns this exchange. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const id = agentIdParam((await ctx.params).id)
    const body = await readJson(req)
    return NextResponse.json({ ok: true, ...(await chat(actor, id, body.text)) })
  } catch (e) { return errorResponse(e) }
}
