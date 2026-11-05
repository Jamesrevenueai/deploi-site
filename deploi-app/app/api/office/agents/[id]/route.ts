import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { EngineError } from '@/lib/engine/errors'
import { HttpError, readJson } from '@/lib/store/request'
import { officeActor, officeError } from '@/lib/office/request'
import { officeAgentDetail } from '@/lib/office/queries'
import { requireAgreements } from '@/lib/legal'
import { editOfficeAgent, grantOfficePolicy, pauseOfficeAgent, resumeOfficeAgent, revokeOfficeAgent } from '@/lib/office/agents'
import { agentCtx } from '@/lib/office/actions'
import { runOfficeAgent, startMeeting } from '@/lib/office/run'
import { requestInboxReading } from '@/lib/office/mailbox'
import { limitActor } from '@/lib/store/request'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await officeActor(req)
    const { id } = await ctx.params
    return NextResponse.json({ ok: true, ...(await officeAgentDetail(actor, id)) })
  } catch (e) { return officeError(e) }
}

/**
 * Body { op: 'grant', policyId, policyHash } | { op: 'edit', policy, name? } | { op: 'pause' } | { op: 'resume' } | { op: 'revoke' } | { op: 'delete' }
 *      | { op: 'run' } | { op: 'meet', email, name? } (Meeting Scheduler: propose three times to this person)
 *      | { op: 'read_inbox' } (Email Operations with "read my inbox" granted: { url, explanation } of the provider consent)
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const actor = await officeActor(req, { mutating: true })
    const { id } = await ctx.params
    const b = await readJson(req)
    if (b.op === 'grant') await requireAgreements(actor, 'office')
    if (b.op === 'grant') return NextResponse.json({ ok: true, ...(await grantOfficePolicy(actor, id, String(b.policyId ?? ''), String(b.policyHash ?? ''))) })
    if (b.op === 'edit') return NextResponse.json({ ok: true, ...(await editOfficeAgent(actor, id, { policy: b.policy, name: typeof b.name === 'string' ? b.name : undefined })) })
    if (b.op === 'pause') return NextResponse.json({ ok: true, ...(await pauseOfficeAgent(actor, id)) })
    if (b.op === 'resume') { await resumeOfficeAgent(actor, id); return NextResponse.json({ ok: true }) }
    if (b.op === 'revoke' || b.op === 'delete') return NextResponse.json({ ok: true, ...(await revokeOfficeAgent(actor, id, { delete: b.op === 'delete' })) })
    // run and meet: the agent must be this organization's (checked through RLS by the detail read)
    await officeAgentDetail(actor, id)
    // Email Operations, "read my inbox": the provider consent for gmail.readonly / Mail.Read on the agent's mailbox
    if (b.op === 'read_inbox') { await requireAgreements(actor, 'office'); await limitActor('oauth_start', actor); return NextResponse.json({ ok: true, ...(await requestInboxReading(actor, id)) }) }
    if (b.op === 'run') return NextResponse.json({ ok: true, ...(await runOfficeAgent(id, { trigger: 'manual' })) })
    if (b.op === 'meet') {
      const c = await admin(db => agentCtx(db, id))
      if (!c || c.agent.kind !== 'meeting_scheduler' || c.agent.status !== 'active' || !c.policy) throw new EngineError('agent_inactive', 'only an active Meeting Scheduler can propose times')
      const r = await startMeeting(c, { contactEmail: String(b.email ?? ''), name: typeof b.name === 'string' ? b.name.slice(0, 80) : null }, new Date())
        .catch(e => { if ((e as Error).name === 'Blocked') throw new EngineError('invalid_input', (e as Error).message); throw e })
      return NextResponse.json({ ok: true, meetingId: r?.meeting.id ?? null, actionId: r?.action.id ?? null, status: r?.action.status ?? null })
    }
    throw new HttpError(400, 'invalid_input', 'unknown operation')
  } catch (e) { return officeError(e) }
}
