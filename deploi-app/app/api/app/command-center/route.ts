import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, HttpError } from '@/lib/store/request'
import { commandCenter, getWorkspace } from '@/lib/app/contract'

export const dynamic = 'force-dynamic'

/** Hero numbers, what needs you, done with proof, the team and the allowance for one side (?workspace=store|office; default: the person's own). */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const q = new URL(req.url).searchParams.get('workspace')
    if (q !== null && q !== 'store' && q !== 'office') throw new HttpError(400, 'invalid_input', 'workspace must be store or office')
    const workspace = q ?? (await getWorkspace(actor)).workspace
    return NextResponse.json({ ok: true, ...(await commandCenter(actor, workspace)) })
  } catch (e) { return errorResponse(e) }
}
