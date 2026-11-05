import { NextResponse } from 'next/server'
import { HttpError, limitActor, readJson } from '@/lib/store/request'
import { officeActor, officeError } from '@/lib/office/request'
import { requireAgreements } from '@/lib/legal'
import { officeConnections } from '@/lib/office/queries'
import { connectSyntheticOffice, disconnectOffice, startOfficeConnect } from '@/lib/office/connections'
import { connectSyntheticMailbox, createOfficeMailbox } from '@/lib/office/mailbox'
import type { OfficeProvider } from '@/lib/office/config'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const actor = await officeActor(req)
    return NextResponse.json({ ok: true, ...(await officeConnections(actor)) })
  } catch (e) { return officeError(e) }
}

const provider = (v: unknown): OfficeProvider => {
  if (v === 'hubspot' || v === 'google_calendar' || v === 'quickbooks') return v
  throw new HttpError(400, 'invalid_input', 'provider must be hubspot, google_calendar or quickbooks')
}

/**
 * Body { op: 'connect', provider }            -> { url } of the provider consent page (503 needs_setup without OAuth credentials)
 *      { op: 'synthetic', provider }          -> a synthetic test connection (not on production)
 *      { op: 'disconnect', id }               -> deletes the stored tokens, cancels queued work needing it
 *      { op: 'mailbox', kind: 'office' | 'synthetic' }
 */
export async function POST(req: Request) {
  try {
    const actor = await officeActor(req, { mutating: true })
    const body = await readJson(req)
    if (body.op === 'connect' || body.op === 'mailbox') await requireAgreements(actor, 'office')
    if (body.op === 'connect') await limitActor('oauth_start', actor)
    if (body.op === 'connect') return NextResponse.json({ ok: true, url: (await startOfficeConnect(actor, provider(body.provider))).url })
    if (body.op === 'synthetic') return NextResponse.json({ ok: true, connection: { id: (await connectSyntheticOffice(actor, provider(body.provider))).id } })
    if (body.op === 'disconnect') return NextResponse.json({ ok: true, ...(await disconnectOffice(actor, String(body.id ?? ''))) })
    if (body.op === 'mailbox') {
      const acc = body.kind === 'synthetic' ? await connectSyntheticMailbox(actor) : await createOfficeMailbox(actor)
      return NextResponse.json({ ok: true, mailbox: { id: acc.id, address: acc.address } })
    }
    throw new HttpError(400, 'invalid_input', 'unknown operation')
  } catch (e) { return officeError(e) }
}
