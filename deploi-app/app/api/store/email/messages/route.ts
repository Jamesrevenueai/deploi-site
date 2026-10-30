import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { listMessages } from '@/lib/email/queries'

export const dynamic = 'force-dynamic'

/** Agent email activity. ?agent=&status=&account= . Subjects are decrypted for merchant users only. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    const q = new URL(req.url).searchParams
    return NextResponse.json({ ok: true, messages: await listMessages(actor, { agentId: q.get('agent'), status: q.get('status'), accountId: q.get('account') }) })
  } catch (e) { return errorResponse(e) }
}
