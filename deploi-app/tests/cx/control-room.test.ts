import './helpers'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { merchantActor, staffActor } from '../merchant/helpers'
import { createAgent, grantPolicy, clearAgentStop } from '../../lib/agents/lifecycle'
import { runAgent } from '../../lib/agents/run'
import { listInbox } from '../../lib/agents/inbox'
import { setSwitch, setTier } from '../../lib/library/switches'
import { agentHealth, controlRoom, integrations, stopAllAgents } from '../../lib/store/control-room'
import type { Actor } from '../../lib/engine/actor'
import { NW, HB, resetCx } from './helpers'

const ready = await prepareDb()

async function agent(actor: Actor, conn: string, name: string, policy: Record<string, unknown> = {}, grant = true) {
  const c = await createAgent(actor, { name, taskText: `${name} task`, policy: { connectionId: conn, productScope: { mode: 'all' }, correctionTypes: ['oversell_policy'], ...policy } })
  if (grant) await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
  return c.agentId
}

const row = (o: Partial<Parameters<typeof agentHealth>[0]> = {}) => ({
  id: 'a', name: 'A', status: 'active', next_run_at: null, last_run_at: null, version: 1, approval_mode: 'draft', correction_count: 1, email_permission: null,
  valid_until: null, email_valid_until: null, pending_version: null, awaiting: 0, needs_person: 0, last_status: 'completed', last_reason: null, last_finished: null, ...o,
})

describe('agent health', () => {
  const now = new Date('2026-11-04T12:00:00Z')
  it('is active when nothing needs the owner, and lists every reason otherwise', () => {
    expect(agentHealth(row(), now)).toEqual({ health: 'active', attention: [], expiresAt: null })
    expect(agentHealth(row({ status: 'paused' }), now).health).toBe('paused')
    expect(agentHealth(row({ status: 'draft' }), now)).toMatchObject({ health: 'draft', attention: ['waiting for your grant'] })
    const h = agentHealth(row({ pending_version: 3, last_status: 'failed', last_reason: 'store offline', needs_person: 2, valid_until: '2026-11-10T00:00:00Z' }), now)
    expect(h.health).toBe('needs_attention')
    expect(h.attention).toEqual(['version 3 waits for your grant', 'last run failed: store offline', '2 items need a person', 'its standing authorization ends in 6 days'])
    expect(h.expiresAt).toBe('2026-11-10T00:00:00Z')
    expect(agentHealth(row({ email_valid_until: '2026-11-01T00:00:00Z' }), now).attention[0]).toMatch(/has ended/)
  })
})

describe.skipIf(!ready)('Control Room', () => {
  beforeEach(async () => { await admin(db => db.query('update org_controls set agents_stopped = false where org_id = any($1)', [[NW.org, HB.org]])); await resetCx(NW); await resetCx(HB) })
  afterAll(async () => { await resetCx(NW); await resetCx(HB) })

  it('aggregates only the signed-in organization: agents, approvals, issues, connections and the weekly estimate', async () => {
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    const reviewer = await agent(nw, NW.conn, 'Reviewer', { approvalMode: 'review' })
    await agent(nw, NW.conn, 'Drafter')
    await agent(nw, NW.conn, 'Not granted yet', {}, false)
    await agent(hb, HB.conn, 'Harbor agent')
    await runAgent(reviewer, { trigger: 'manual', actor: nw.label })

    const cr = await controlRoom(nw)
    expect(cr.org.id).toBe(NW.org)
    expect(cr.agents.map(a => a.name).sort()).toEqual(['Drafter', 'Not granted yet', 'Reviewer'])
    expect(cr.counts.total).toBe(3)
    expect(cr.counts.draft).toBe(1)
    expect(cr.agents.find(a => a.name === 'Reviewer')).toMatchObject({ storeTier: 'send_approved', version: 1 })
    expect(cr.agents.find(a => a.name === 'Drafter')).toMatchObject({ storeTier: 'draft' })
    expect(cr.agents.find(a => a.name === 'Not granted yet')).toMatchObject({ health: 'draft', attention: ['waiting for your grant'] })

    const inbox = await listInbox(nw)
    const approvable = inbox.changes.filter(c => c.kind === 'approval').length + inbox.emails.filter(e => e.status === 'awaiting_approval').length
    expect(approvable).toBeGreaterThan(0)
    expect(cr.approvals.count).toBe(approvable)
    expect(cr.approvals.items.length).toBe(Math.min(10, approvable))
    expect(cr.approvals.items.every(i => i.agentName === 'Reviewer')).toBe(true)
    expect(cr.issues.total).toBe(cr.issues.high + cr.issues.medium + cr.issues.low)
    expect(cr.connections.stores.map(s => s.id)).toEqual([NW.conn])
    expect(cr.products).toEqual(['commerce'])
    expect(cr.weekly.label).toBe('Estimate')

    const hcr = await controlRoom(hb)
    expect(hcr.agents.map(a => a.name)).toEqual(['Harbor agent'])
    expect(hcr.approvals.count).toBe(0)
    expect(hcr.connections.stores.map(s => s.id)).toEqual([HB.conn])
    await expect(controlRoom(await staffActor())).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('Stop all agents pauses every active agent and library agent of this organization only, and is idempotent', async () => {
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    await agent(nw, NW.conn, 'One')
    await agent(nw, NW.conn, 'Two', { approvalMode: 'review' })
    await agent(nw, NW.conn, 'Draft one', {}, false)
    const harbor = await agent(hb, HB.conn, 'Harbor keeps running')
    await setTier(nw, 'pro')
    await setSwitch(nw, 'listing_writer', true)

    const r = await stopAllAgents(nw)
    expect(r).toMatchObject({ paused: 2, alreadyStopped: 1, librarySwitchedOff: 1, failed: [] })
    const states = await admin(db => db.query<{ status: string }>(`select status from agents where org_id = $1 and status <> 'deleted'`, [NW.org]))
    expect(states.filter(s => s.status === 'active')).toHaveLength(0)
    expect((await admin(db => db.one<{ n: number }>(`select count(*)::int as n from library_switches where org_id = $1 and enabled`, [NW.org])))!.n).toBe(0)
    expect((await admin(db => db.one<{ status: string }>('select status from agents where id = $1', [harbor])))!.status).toBe('active')
    // the organization stop switch is on for Northwind only (sends held, resume refused until cleared)
    expect((await admin(db => db.one<{ agents_stopped: boolean }>('select agents_stopped from org_controls where org_id = $1', [NW.org])))!.agents_stopped).toBe(true)
    expect((await admin(db => db.one<{ agents_stopped: boolean }>('select agents_stopped from org_controls where org_id = $1', [HB.org])))?.agents_stopped ?? false).toBe(false)
    expect(await stopAllAgents(nw)).toMatchObject({ paused: 0, alreadyStopped: 3, librarySwitchedOff: 0 })
    await expect(stopAllAgents(await staffActor())).rejects.toMatchObject({ code: 'forbidden' })
    const cr = await controlRoom(nw)
    expect(cr.counts.paused).toBe(2)
    expect(cr.counts.active).toBe(0)
    await clearAgentStop(nw)
  })

  it('integrations are honest: a store row means connected, email providers are never live-verified, office tools without credentials are not available', async () => {
    const list = await integrations(await merchantActor(NW))
    const by = Object.fromEntries(list.map(i => [i.key, i]))
    expect(Object.keys(by).sort()).toEqual(['agent_mailbox', 'gmail', 'google_calendar', 'hubspot', 'microsoft', 'shopify', 'stripe', 'woocommerce'])
    expect(by.shopify.status).toBe('connected')
    expect(by.woocommerce.status).toBe('needs_setup')
    expect(by.hubspot.status).toBe('not_available') // no HubSpot OAuth client on this environment; connected once an office connection row exists
    expect(by.google_calendar.href).toBe('/office/connections')
    for (const k of ['gmail', 'microsoft']) { expect(by[k].liveVerified).toBe(false); expect(by[k].detail).toMatch(/Not live-verified/) }
    expect(list.every(i => i.permissions.length > 0 && i.usedFor.length > 0)).toBe(true)
    await expect(integrations(await staffActor())).rejects.toMatchObject({ code: 'forbidden' })
  })
})
