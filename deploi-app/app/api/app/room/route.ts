import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { teamRoom, getWorkspace } from '@/lib/app/contract'

export const dynamic = 'force-dynamic'

/** The team room (agents to each other and to you), oldest first; ?workspace=store|office (default: the person's own). */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const q = new URL(req.url).searchParams.get('workspace')
    if (q !== null && q !== 'store' && q !== 'office') throw new HttpError(400, 'invalid_input', 'workspace must be store or office')
    const workspace = q ?? (await getWorkspace(actor)).workspace
    return NextResponse.json({ ok: true, workspace, messages: await teamRoom(actor, workspace) })
  } catch (e) { return errorResponse(e) }
}
