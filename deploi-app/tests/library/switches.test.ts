import { describe, it, expect, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { NW, resetLibrary, actionsOf } from './helpers'
import { merchantActor } from '../merchant/helpers'
import { setSwitch, setSettings, setInstructions, teamView } from '../../lib/library/switches'
import { runLibraryAgent, runDueLibraryAgents } from '../../lib/library/actions'
import { admin } from '../../lib/db'

const ready = await prepareDb()
const NOW = new Date('2026-10-29T12:00:00Z')

describe.skipIf(!ready)('the on/off switch for engine-backed agents and the scheduler', () => {
  beforeEach(() => resetLibrary(NW, 'pro'))

  it('switching on Inventory Watcher creates and grants its correction-engine agent at drafts only; off pauses it; on again resumes it', async () => {
    const actor = await merchantActor(NW)
    const on = await setSwitch(actor, 'inventory_watcher', true)
    expect(on.engineAgentId).toBeTruthy()
    const agent = (await admin(db => db.one<{ status: string; name: string; active_policy_id: string | null }>('select status, name, active_policy_id from agents where id = $1', [on.engineAgentId])))!
    expect(agent).toMatchObject({ status: 'active', name: 'Inventory Watcher' })
    const policy = (await admin(db => db.one<{ policy: { approvalMode: string; email: { permission: string; notify: string[] } } }>('select policy from agent_policies where id = $1', [agent.active_policy_id])))!
    expect(policy.policy.approvalMode).toBe('draft')
    expect(policy.policy.email).toMatchObject({ permission: 'draft', notify: [NW.email] })
    // a run uses the engine and records its counts as proof, and the library view also drafts
    const r = await runLibraryAgent({ orgId: NW.org, agentKey: 'inventory_watcher', trigger: 'test', actor: actor.label, now: new Date() }) // the engine expires proposals against the real clock
    expect(r.engine).toMatchObject({ status: 'completed' })
    expect((r.engine as { counts: { drafted: number } }).counts.drafted).toBeGreaterThan(0)
    await setSwitch(actor, 'inventory_watcher', false)
    expect((await admin(db => db.one<{ status: string }>('select status from agents where id = $1', [on.engineAgentId])))!.status).toBe('paused')
    const again = await setSwitch(actor, 'inventory_watcher', true)
    expect(again.engineAgentId).toBe(on.engineAgentId)
    expect((await admin(db => db.one<{ status: string }>('select status from agents where id = $1', [on.engineAgentId])))!.status).toBe('active')
    expect((await teamView(actor)).agents.find(a => a.key === 'inventory_watcher')!.engineAgentId).toBe(on.engineAgentId)
  })

  it('Supplier Chaser needs the supplier address before it can be switched on; settings satisfy it', async () => {
    const actor = await merchantActor(NW)
    expect((await teamView(actor)).agents.find(a => a.key === 'supplier_chaser')!.needs).toEqual([{ key: 'supplierAddress', label: "your supplier's email address" }])
    await expect(setSwitch(actor, 'supplier_chaser', true)).rejects.toMatchObject({ code: 'needs_setup' })
    await setSettings(actor, 'supplier_chaser', { supplierAddress: 'orders@supplier.example' })
    expect((await teamView(actor)).agents.find(a => a.key === 'supplier_chaser')!.needs).toEqual([])
    const on = await setSwitch(actor, 'supplier_chaser', true)
    expect(on.engineAgentId).toBeTruthy()
    const r = await runLibraryAgent({ orgId: NW.org, agentKey: 'supplier_chaser', trigger: 'test', actor: actor.label, now: NOW })
    expect(r.counts.drafted).toBe(1)
    expect((await actionsOf(NW, 'supplier_chaser'))[0].payload.to).toBe('orders@supplier.example')
  })

  it('standing instructions are read on every run', async () => {
    const actor = await merchantActor(NW)
    await setSwitch(actor, 'listing_writer', true)
    await setInstructions(actor, 'listing_writer', 'formal tone, under 30 words')
    await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
    const d = (await actionsOf(NW, 'listing_writer')).find(a => a.action_type === 'draft_description')!
    expect(String(d.payload.to)).toMatch(/is made to a high standard/)
    expect(String(d.payload.to).split(/\s+/).length).toBeLessThanOrEqual(31)
  })

  it('the scheduler runs each switched-on agent once a day and skips the ones that ran', async () => {
    const actor = await merchantActor(NW)
    await setSwitch(actor, 'ai_visibility', true)
    await setSwitch(actor, 'weekly_insights', true)
    const first = await runDueLibraryAgents({ now: NOW })
    expect(first.filter(r => r.orgId === NW.org).map(r => r.agentKey).sort()).toEqual(['ai_visibility', 'weekly_insights'])
    expect(first.every(r => r.status === 'completed')).toBe(true)
    const second = await runDueLibraryAgents({ now: NOW })
    expect(second.filter(r => r.orgId === NW.org)).toEqual([])
  })
})
