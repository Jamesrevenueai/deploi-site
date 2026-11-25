import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { chat, chatHistory } from '@/lib/app/contract'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** The team conversation, oldest first. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, messages: await chatHistory(actor, null) })
  } catch (e) { return errorResponse(e) }
}

/** { text, workspace? }: the team answers, rules only (AI is off). Returns this exchange. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    return NextResponse.json({ ok: true, ...(await chat(actor, null, body.text, { workspace: body.workspace })) })
  } catch (e) { return errorResponse(e) }
}
