import { NextResponse } from 'next/server'
import { resolveActor, errorResponse, readJson, HttpError } from '@/lib/store/request'
import { listAccounts, providers } from '@/lib/email/queries'
import { startConnect } from '@/lib/email/accounts'
import type { EmailProvider } from '@/lib/email/types'

export const dynamic = 'force-dynamic'

/** Connected email accounts (sender, health, granted permissions, usage) and which providers are available here. */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    return NextResponse.json({ ok: true, accounts: await listAccounts(actor), providers: providers() })
  } catch (e) { return errorResponse(e) }
}

/** Start connecting an account. Body { provider, read?, accountId? (reconnect), returnTo? }. Returns the provider consent URL. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    const body = await readJson(req)
    const provider = String(body.provider ?? '') as EmailProvider
    if (!['gmail', 'microsoft', 'synthetic'].includes(provider)) throw new HttpError(400, 'invalid_input', 'unknown provider')
    const r = await startConnect(actor, { provider, read: body.read === true, accountId: typeof body.accountId === 'string' ? body.accountId : null, returnTo: typeof body.returnTo === 'string' ? body.returnTo : null })
    return NextResponse.json({ ok: true, ...r })
  } catch (e) { return errorResponse(e) }
}
