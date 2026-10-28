import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { checkAccount, disconnectAccount, startConnect, visibleAccount } from '@/lib/email/accounts'

export const dynamic = 'force-dynamic'

/**
 * check: health check (token refresh if due + identity read; sends nothing).
 * reconnect { read? }: start the provider consent again for the same account (e.g. to add read access).
 * disconnect: revoke where the provider allows it, delete tokens, cancel every unsent message from the account.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const { id, action } = await ctx.params
    const body = await readJson(req).catch(() => ({} as Record<string, unknown>))
    if (action === 'check') return NextResponse.json({ ok: true, account: await checkAccount(actor, id) })
    if (action === 'disconnect') return NextResponse.json({ ok: true, ...(await disconnectAccount(actor, id)) })
    if (action === 'reconnect') {
      const acc = await visibleAccount(actor, id)
      return NextResponse.json({ ok: true, ...(await startConnect(actor, { provider: acc.provider, accountId: acc.id, read: body.read === true || acc.can_read, returnTo: typeof body.returnTo === 'string' ? body.returnTo : null })) })
    }
    throw new HttpError(404, 'not_found', 'unknown action')
  } catch (e) { return errorResponse(e) }
}
