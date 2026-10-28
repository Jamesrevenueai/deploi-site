import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { listAgents } from '@/lib/agents/queries'
import { createAgent } from '@/lib/agents/lifecycle'
import { parseTask } from '@/lib/agents/parse'

export const dynamic = 'force-dynamic'

/** The organization's agents. ?connection=<id> */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, agents: await listAgents(actor, new URL(req.url).searchParams.get('connection')) })
  } catch (e) { return errorResponse(e) }
}

/**
 * Body { op: 'parse', text } turns plain English into a draft for review (grants nothing).
 * Body { name, taskText, policy } creates the agent as a draft whose first authorization waits for a grant.
 */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    if (body.op === 'parse') {
      const text = String(body.text ?? '').slice(0, 2000)
      if (!text.trim()) throw new HttpError(400, 'invalid_input', 'describe the task in a sentence or two')
      return NextResponse.json({ ok: true, draft: parseTask(text) })
    }
    const r = await createAgent(actor, { name: String(body.name ?? ''), taskText: String(body.taskText ?? ''), policy: body.policy })
    return NextResponse.json({ ok: true, ...r })
  } catch (e) { return errorResponse(e) }
}
