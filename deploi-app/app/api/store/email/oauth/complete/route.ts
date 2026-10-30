import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson } from '@/lib/store/request'
import { completeConnect } from '@/lib/email/accounts'

export const dynamic = 'force-dynamic'

/** Finish a connection started from the embedded app (the consent window hands state + code back to it). */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    const r = await completeConnect(actor, { state: String(body.state ?? ''), code: typeof body.code === 'string' ? body.code : null, error: typeof body.error === 'string' ? body.error : null })
    return NextResponse.json({ ok: true, account: { id: r.account.id, address: r.account.address, provider: r.account.provider, status: r.account.status } })
  } catch (e) { return errorResponse(e) }
}
