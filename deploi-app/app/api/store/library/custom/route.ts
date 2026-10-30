import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { createCustomAgent } from '@/lib/library/custom'

export const dynamic = 'force-dynamic'

/** Build your own agent (Pro): { name, job, permission? } — permission defaults to read, the most restrictive level. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    return NextResponse.json({ ok: true, agent: await createCustomAgent(actor, { name: String(body.name ?? ''), job: String(body.job ?? ''), permission: body.permission }) })
  } catch (e) { return errorResponse(e) }
}
