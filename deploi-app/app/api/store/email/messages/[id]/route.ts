import { NextResponse } from 'next/server'
import { resolveActor, errorResponse } from '@/lib/store/request'
import { getMessage } from '@/lib/email/queries'

export const dynamic = 'force-dynamic'

/** One message: exact sender, recipients, subject, body and attachments, plus the content hash an approval binds to. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await resolveActor(req)
    const { id } = await ctx.params
    return NextResponse.json({ ok: true, message: await getMessage(actor, id) })
  } catch (e) { return errorResponse(e) }
}
