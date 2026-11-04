/**
 * The seams between workstreams: Deploi Office actions in the unified approvals inbox, the organization
 * stop switch covering Office agents, and the agreements gate on every connect / create / grant route.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { getSynthMail } from '../../lib/email/adapters/synthetic'
import { runOfficeAgent } from '../../lib/office/run'
import { executeOfficeAction } from '../../lib/office/actions'
import { resumeOfficeAgent } from '../../lib/office/agents'
import { listPendingApprovals, decideApproval } from '../../lib/approvals'
import { stopAllAgents, clearAgentStop } from '../../lib/agents/lifecycle'
import { requireAgreements } from '../../lib/legal'
import { NW, HB, merchantActor, setupOffice, grantedAgent, actions, lead, t0, type OfficeSetup, resetOffice } from '../office/helpers'

const ready = await prepareDb()
// leave no Office agents, actions or connections behind for other test files
afterAll(async () => { if (ready) { await resetOffice(NW, { enable: false }); await resetOffice(HB, { enable: false }) } })
const clearStops = () => admin(db => db.query('update org_controls set agents_stopped = false where org_id = any($1)', [[NW.org, HB.org]]))

describe.skipIf(!ready)('cross-workstream integration', () => {
  let s: OfficeSetup
  const T = t0()
  beforeEach(async () => {
    await clearStops()
    s = await setupOffice(NW, [lead('801', 'bo@lumen-cafe.example', new Date(T.getTime() - 3600e3))])
  })
  afterAll(clearStops)

  it('an Office email waiting for approval is in the unified inbox with its exact content, is invisible to another organization, and approving it there sends once', async () => {
    const agent = await grantedAgent(s, 'lead_followup', { email: 'send_approved' })
    await runOfficeAgent(agent, { trigger: 'test', now: T })
    const [a] = await actions(agent)
    expect(a.status).toBe('awaiting_approval')

    const nw = await merchantActor(NW)
    const { items } = await listPendingApprovals(nw, { source: 'office' })
    const it0 = items.find(i => i.id === a.id)!
    expect(it0).toMatchObject({ source: 'office', version: a.payload_hash, decisions: ['approve', 'reject'] })
    expect(it0.content).toMatchObject({ type: 'email', to: 'bo@lumen-cafe.example' })
    // the Office email is not listed a second time by the email source
    expect((await listPendingApprovals(nw)).items.filter(i => i.id === a.id || (i.source === 'email' && (i.content as { to?: string[] }).to?.includes('bo@lumen-cafe.example')))).toHaveLength(1)

    const hb = await merchantActor(HB)
    expect((await listPendingApprovals(hb, { source: 'office' })).items.find(i => i.id === a.id)).toBeUndefined()
    await expect(decideApproval(hb, 'office', a.id, 'approve', { version: a.payload_hash })).rejects.toBeTruthy()
    await expect(decideApproval(nw, 'office', a.id, 'approve', { version: 'stale' })).rejects.toBeTruthy()
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(0)

    const r = await decideApproval(nw, 'office', a.id, 'approve', { version: a.payload_hash })
    expect(r.status).toBe('succeeded')
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(1)
    await expect(decideApproval(nw, 'office', a.id, 'approve', { version: a.payload_hash })).rejects.toBeTruthy()
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(1)
  })

  it('Stop all agents also pauses Office agents, cancels their waiting and queued work, refuses resume, and an already-queued action is not carried out', async () => {
    const agent = await grantedAgent(s, 'lead_followup', { email: 'send_approved' })
    await runOfficeAgent(agent, { trigger: 'test', now: T })
    const [a] = await actions(agent)
    // simulate an approved item sitting in the queue when the stop lands
    await admin(db => db.query(`update office_actions set status = 'queued', approval_kind = 'individual', approved_by = 'user:test', approved_hash = payload_hash, approved_at = now() where id = $1`, [a.id]))

    const nw = await merchantActor(NW)
    const out = await stopAllAgents(nw, 'integration test')
    expect(out.officeAgentsPaused).toBe(1)
    expect((await admin(db => db.one<{ status: string }>('select status from office_agents where id = $1', [agent])))!.status).toBe('paused')
    expect((await actions(agent))[0].status).toBe('cancelled')
    await expect(resumeOfficeAgent(nw, agent)).rejects.toMatchObject({ code: 'agent_inactive' })

    // even if something re-queued it, execution refuses while the organization is stopped
    await admin(db => db.query(`update office_agents set status = 'active' where id = $1`, [agent]))
    await admin(db => db.query(`update office_actions set status = 'queued', next_attempt_at = null where id = $1`, [a.id]))
    const ex = await executeOfficeAction(a.id, { now: T })
    expect(ex.status).toBe('cancelled')
    expect(ex.reason).toMatch(/stopped/)
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(0)

    await clearAgentStop(nw)
  })

  it('the agreements gate refuses commerce and office work until the current texts are accepted (LEGAL_GATE=draft)', async () => {
    const nw = await merchantActor(NW)
    await admin(db => db.query('delete from legal_acceptances where org_id = $1', [NW.org]))
    const prev = process.env.LEGAL_GATE
    process.env.LEGAL_GATE = 'draft'
    try {
      await expect(requireAgreements(nw, 'commerce')).rejects.toBeTruthy()
      await expect(requireAgreements(nw, 'office')).rejects.toBeTruthy()
    } finally { if (prev === undefined) delete process.env.LEGAL_GATE; else process.env.LEGAL_GATE = prev }
    await requireAgreements(nw, 'office') // off by default
  })

  it('every connect, create and grant entry point calls the agreements gate', () => {
    const root = join(__dirname, '..', '..')
    const gated: [string, string][] = [
      ['app/api/woocommerce/connect/route.ts', "requireAgreements(actor, 'commerce')"],
      ['app/api/woocommerce/keys/route.ts', "requireAgreements(actor, 'commerce')"],
      ['app/api/office/connections/route.ts', "requireAgreements(actor, 'office')"],
      ['app/api/office/agents/route.ts', "requireAgreements(actor, 'office')"],
      ['app/api/office/agents/[id]/route.ts', "requireAgreements(actor, 'office')"],
    ]
    for (const [f, call] of gated) expect(readFileSync(join(root, f), 'utf8'), f).toContain(call)
  })
})
