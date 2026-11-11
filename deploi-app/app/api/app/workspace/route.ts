import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { getWorkspace, setWorkspace } from '@/lib/app/contract'

export const dynamic = 'force-dynamic'

/** Which side of the app this person sees (store | office), the organization's default, and whether they chose it. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, ...(await getWorkspace(actor)) })
  } catch (e) { return errorResponse(e) }
}

/** { workspace: 'store' | 'office' }: this person's own choice (any member). */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    return NextResponse.json({ ok: true, ...(await setWorkspace(actor, body.workspace)) })
  } catch (e) { return errorResponse(e) }
}
