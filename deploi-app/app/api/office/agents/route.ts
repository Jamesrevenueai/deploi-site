import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { HttpError, readJson } from '@/lib/store/request'
import { officeActor, officeError } from '@/lib/office/request'
import { officeAgents } from '@/lib/office/queries'
import { createOfficeAgent } from '@/lib/office/agents'
import { officeTemplate, officeTemplatePolicy } from '@/lib/office/templates'
import { activeConnection } from '@/lib/office/connections'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const actor = await officeActor(req)
    return NextResponse.json({ ok: true, ...(await officeAgents(actor)) })
  } catch (e) { return officeError(e) }
}

/**
 * Body { template, name?, mailboxAccountId?, timezone?, senderName?, pitch? }: a new agent from a template, drafts
 * only for every tool, using the organization's connected HubSpot and Calendar. Or { kind, name, policy }.
 * Either way its authorization waits for a grant.
 */
export async function POST(req: Request) {
  try {
    const actor = await officeActor(req, { mutating: true })
    const b = await readJson(req)
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    if (typeof b.template === 'string') {
      const t = officeTemplate(b.template)
      if (!t) throw new HttpError(400, 'invalid_input', 'unknown template')
      const [hs, cal] = await admin(db => Promise.all([activeConnection(db, actor.orgId, 'hubspot'), activeConnection(db, actor.orgId, 'google_calendar')]))
      const policy = officeTemplatePolicy(t.key, { hubspotConnectionId: hs?.id ?? null, calendarConnectionId: cal?.id ?? null, mailboxAccountId: str(b.mailboxAccountId) ?? null,
        timezone: str(b.timezone) ?? cal?.timezone ?? 'UTC', senderName: str(b.senderName), pitch: str(b.pitch) })
      return NextResponse.json({ ok: true, ...(await createOfficeAgent(actor, { kind: t.key, name: str(b.name) ?? t.name, policy })) })
    }
    if (typeof b.kind !== 'string') throw new HttpError(400, 'invalid_input', 'choose a template')
    return NextResponse.json({ ok: true, ...(await createOfficeAgent(actor, { kind: b.kind as never, name: String(b.name ?? ''), policy: b.policy })) })
  } catch (e) { return officeError(e) }
}
