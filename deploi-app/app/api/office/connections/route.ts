import { NextResponse, after } from 'next/server'
import { HttpError, limitActor, readJson } from '@/lib/store/request'
import { officeActor, officeError } from '@/lib/office/request'
import { requireAgreements } from '@/lib/legal'
import { officeConnections } from '@/lib/office/queries'
import { connectBuildium, connectSyntheticOffice, disconnectOffice, startOfficeConnect } from '@/lib/office/connections'
import { connectSyntheticMailbox, createOfficeMailbox } from '@/lib/office/mailbox'
import { isSyntheticProvider, OFFICE_PROVIDERS, type OfficeProvider } from '@/lib/office/config'
import { requestDiscovery } from '@/lib/discovery/jobs'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const actor = await officeActor(req)
    return NextResponse.json({ ok: true, ...(await officeConnections(actor)) })
  } catch (e) { return officeError(e) }
}

const provider = (v: unknown): OfficeProvider => {
  if ((OFFICE_PROVIDERS as unknown[]).includes(v)) return v as OfficeProvider
  throw new HttpError(400, 'invalid_input', `provider must be one of ${OFFICE_PROVIDERS.join(', ')}`)
}

/**
 * Body { op: 'connect', provider }            -> { url } of the provider consent page (503 needs_setup without OAuth credentials)
 *      { op: 'synthetic', provider }          -> a synthetic test connection (not on production)
 *      { op: 'api_key', provider: 'buildium', clientId, clientSecret } -> checks the key with one read, stores it encrypted
 *      { op: 'disconnect', id }               -> revokes where the provider allows it, deletes the stored tokens, cancels queued work needing it
 *      { op: 'mailbox', kind: 'office' | 'synthetic' }
 */
export async function POST(req: Request) {
  try {
    const actor = await officeActor(req, { mutating: true })
    const body = await readJson(req)
    if (body.op === 'connect' || body.op === 'mailbox' || body.op === 'api_key') await requireAgreements(actor, 'office')
    if (body.op === 'connect' || body.op === 'api_key') await limitActor('oauth_start', actor)
    if (body.op === 'api_key') {
      if (body.provider !== 'buildium') throw new HttpError(400, 'invalid_input', 'only Buildium connects with an API key')
      const conn = await connectBuildium(actor, { clientId: typeof body.clientId === 'string' ? body.clientId : undefined, clientSecret: typeof body.clientSecret === 'string' ? body.clientSecret : undefined })
      return NextResponse.json({ ok: true, connection: { id: conn.id } })
    }
    if (body.op === 'connect') return NextResponse.json({ ok: true, url: (await startOfficeConnect(actor, provider(body.provider))).url })
    if (body.op === 'synthetic') {
      const p = provider(body.provider)
      if (!isSyntheticProvider(p)) throw new HttpError(400, 'invalid_input', 'a synthetic test account exists for HubSpot, Google Calendar and QuickBooks only')
      const conn = await connectSyntheticOffice(actor, p)
      after(() => requestDiscovery(conn.org_id, `${conn.provider}:${conn.id}`))
      return NextResponse.json({ ok: true, connection: { id: conn.id } })
    }
    if (body.op === 'disconnect') return NextResponse.json({ ok: true, ...(await disconnectOffice(actor, String(body.id ?? ''))) })
    if (body.op === 'mailbox') {
      const acc = body.kind === 'synthetic' ? await connectSyntheticMailbox(actor) : await createOfficeMailbox(actor)
      after(() => requestDiscovery(acc.org_id, `mailbox:${acc.id}`))
      return NextResponse.json({ ok: true, mailbox: { id: acc.id, address: acc.address } })
    }
    throw new HttpError(400, 'invalid_input', 'unknown operation')
  } catch (e) { return officeError(e) }
}
