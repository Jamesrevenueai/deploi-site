import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { competitorView, setFindingsStatus } from '@/lib/competitors/queries'

export const dynamic = 'force-dynamic'

/** Monitored stores, findings with their evidence, and recent checks of a competitor watcher. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    const { id } = await ctx.params
    return NextResponse.json({ ok: true, ...(await competitorView(actor, id)) })
  } catch (e) { return errorResponse(e) }
}

/** Body { status: 'seen' | 'dismissed', ids?: string[] }: mark findings seen (all new ones when ids is omitted) or dismiss them. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id } = await ctx.params
    const body = await readJson(req)
    if (body.status !== 'seen' && body.status !== 'dismissed') throw new HttpError(400, 'invalid_input', 'status must be seen or dismissed')
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x)).slice(0, 500) : null
    return NextResponse.json({ ok: true, updated: await setFindingsStatus(actor, id, body.status, ids) })
  } catch (e) { return errorResponse(e) }
}
