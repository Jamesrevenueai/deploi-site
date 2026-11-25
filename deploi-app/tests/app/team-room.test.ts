/**
 * Delegated tasks, the team room and "what your team learned" (lib/app/tasks.ts, room.ts, learned.ts) on the real
 * database: a task becomes a case the agent owns and shows on its page and in the room; the agent answers honestly
 * (AI is off) and runs its check; the owner marks it done (resolved with their confirmation) or cancels it; the chat
 * gives tasks ("<agent>, please ..."); handoffs between agents show as agent-to-agent messages; what Deploi read
 * shows only real numbers, and nothing when it never read anything.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import type { Actor } from '../../lib/engine/actor'
import { delegateTask, finishTask, teamRoom, learned, agentDashboard, chat } from '../../lib/app/contract'
import { intentOf } from '../../lib/app/chat'
import { openCase, handOffCase } from '../../lib/cases'
import { registerPackAgents } from '../../lib/packs/registry'
import { NW, HB, merchantActor } from '../merchant/helpers'
import { person, removePeople } from '../platform/helpers'

const ready = await prepareDb()

const KEY = 'tr_helper'
const REF = `pack:${KEY}`
registerPackAgents([{ key: KEY, name: 'Room Helper', pack: 'home_services', job: 'Helps in the team room tests.', triggers: ['sweep'], actions: ['update_record'], status: 'working', shopifyReady: false }])

let savedPacks: Record<string, unknown> | null = null
async function clean() {
  await admin(async db => {
    await db.query(`delete from cases where org_id = any($1) and (kind = 'owner_task' or dedupe_key like 'tr:%')`, [[NW.org, HB.org]])
    await db.query(`delete from agent_chat_messages where org_id = $1`, [NW.org])
    await db.query(`delete from discovery_runs where org_id = $1 and created_by = 'test:team-room'`, [NW.org])
    await db.query(`delete from library_switches where org_id = $1 and agent_key = 'listing_writer' and switched_by = 'test:team-room'`, [NW.org])
  })
}

describe.skipIf(!ready)('delegated tasks, the team room and what the team learned', () => {
  let owner: Actor
  beforeAll(async () => {
    savedPacks = await admin(db => db.one<Record<string, unknown>>('select * from pack_settings where org_id = $1', [NW.org]))
    await admin(db => db.query(`insert into pack_settings (org_id, business_type, packs, updated_by) values ($1, 'home_services', '{home_services}', 'test')
      on conflict (org_id) do update set business_type = 'home_services', packs = '{home_services}'`, [NW.org]))
    owner = await merchantActor(NW)
  })
  beforeEach(clean)
  afterAll(async () => {
    await clean(); await removePeople(NW)
    await admin(async db => {
      await db.query('delete from pack_settings where org_id = $1', [NW.org])
      if (savedPacks) await db.query(`insert into pack_settings (org_id, business_type, packs, trade, settings, updated_by, source) values ($1,$2,$3,$4,$5,$6,$7)`,
        [NW.org, savedPacks.business_type, savedPacks.packs, savedPacks.trade, JSON.stringify(savedPacks.settings ?? {}), savedPacks.updated_by, savedPacks.source ?? 'owner'])
    })
  })

  it('a delegated task is a case the agent owns: picked up, on its page, with an honest answer about what it can do', async () => {
    const t = await delegateTask(owner, REF, '  Call back the Smith job about the quote  ')
    expect(t.ref).toMatch(/^DC-\d{6}$/)
    expect(t.text).toBe('Call back the Smith job about the quote')
    expect(t.agentName).toBe('Room Helper')
    expect(t.status).toBe('investigating')
    expect(t.reply).toMatch(/running my check now/)
    expect(t.reply).toMatch(/needs AI, which is off/)
    const c = await admin(db => db.one<{ kind: string; source_app: string; suite: string; status: string; problem: string }>('select kind, source_app, suite, status, problem from cases where ref = $1', [t.ref]))
    expect(c).toMatchObject({ kind: 'owner_task', source_app: 'deploi', suite: 'office', status: 'investigating', problem: 'Call back the Smith job about the quote' })
    const d = await agentDashboard(owner, REF)
    expect(d.tasks).toEqual([expect.objectContaining({ ref: t.ref, text: 'Call back the Smith job about the quote', open: true, result: 'Looking into it' })])
    expect(d.work.some(w => w.proof?.label === `Case ${t.ref}`)).toBe(true)
  })

  it('the owner closes a task: done resolves it with their confirmation, cancel cancels it; a closed task cannot be closed again', async () => {
    const a = await delegateTask(owner, REF, 'Send the March invoices')
    expect(await finishTask(owner, a.ref, 'done')).toEqual({ ref: a.ref, status: 'resolved' })
    const r = await admin(db => db.one<{ status: string; outcome: { verifiedBy: string; evidence: { source: string }[] } }>('select status, outcome from cases where ref = $1', [a.ref]))
    expect(r!.status).toBe('resolved')
    expect(r!.outcome.verifiedBy).toBe('owner')
    expect(r!.outcome.evidence[0].source).toBe('owner')
    await expect(finishTask(owner, a.ref, 'cancel')).rejects.toMatchObject({ code: 'not_pending' })
    const b = await delegateTask(owner, REF, 'Order more filters')
    expect(await finishTask(owner, b.ref, 'cancel')).toEqual({ ref: b.ref, status: 'cancelled' })
    const d = await agentDashboard(owner, REF)
    expect(d.tasks.map(x => [x.ref, x.open])).toEqual(expect.arrayContaining([[a.ref, false], [b.ref, false]]))
  })

  it('refuses what it should: empty or too long text, an unknown agent, a bad op, another business’s task, a viewer', async () => {
    await expect(delegateTask(owner, REF, '   ')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(delegateTask(owner, REF, 'x'.repeat(501))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(delegateTask(owner, 'pack:no_such_agent', 'do it')).rejects.toMatchObject({ code: 'not_found' })
    await expect(delegateTask(owner, 'nonsense', 'do it')).rejects.toMatchObject({ code: 'not_found' })
    const t = await delegateTask(owner, REF, 'Check the van schedule')
    await expect(finishTask(owner, t.ref, 'archive')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(finishTask(await merchantActor(HB), t.ref, 'done')).rejects.toMatchObject({ code: 'not_found' })
    const viewer = await person(NW, 'viewer')
    await expect(delegateTask(viewer, REF, 'Do something')).rejects.toBeTruthy()
    expect((await admin(db => db.one<{ status: string }>('select status from cases where ref = $1', [t.ref])))!.status).toBe('investigating')
  })

  it('the team room shows the task from you to the agent, the agent picking it up and answering, then you closing it', async () => {
    const t = await delegateTask(owner, REF, 'Ring the supplier about the filters')
    await finishTask(owner, t.ref, 'done')
    const room = (await teamRoom(owner, 'office')).filter(m => m.caseRef === t.ref)
    expect(room.map(m => m.kind)).toEqual(['task', 'picked_up', 'note', 'checked'])
    expect(room[0]).toMatchObject({ from: { kind: 'owner', name: 'You' }, to: { id: REF, name: 'Room Helper' }, text: 'Room Helper, Ring the supplier about the filters' })
    expect(room[1]).toMatchObject({ from: { id: REF, kind: 'agent' }, to: { kind: 'owner' } })
    expect(room[2].text).toMatch(/needs AI, which is off/)
    expect(room[3]).toMatchObject({ from: { kind: 'owner' }, text: 'Done: Ring the supplier about the filters' })
    expect(room.every(m => m.href === `/store/work/${t.ref}`)).toBe(true)
    // the store side does not show office work
    expect((await teamRoom(owner, 'store')).some(m => m.caseRef === t.ref)).toBe(false)
  })

  it('a handoff between two agents is a message from one agent to the other', async () => {
    await admin(db => db.query(`insert into library_switches (org_id, agent_key, enabled, permission, switched_by) values ($1, 'listing_writer', true, 'draft', 'test:team-room')
      on conflict (org_id, agent_key) do nothing`, [NW.org]))
    const caseId = await admin(async db => {
      const { case: c } = await openCase(db, { orgId: NW.org, suite: 'commerce', kind: 'listing_gap', sourceApp: 'shopify', dedupeKey: 'tr:handoff', title: 'Blue mug has no description', problem: 'The listing is empty.',
        agent: { kind: 'library', ref: 'inventory_watcher' }, verification: { criteria: 'The listing has a description' }, actor: 'agent:inventory_watcher' })
      await handOffCase(db, c.id, { kind: 'library', ref: 'listing_writer' }, { actor: 'agent:inventory_watcher', reason: 'Listings are the Listing Writer’s job' })
      return c.id
    })
    const ref = (await admin(db => db.one<{ ref: string }>('select ref from cases where id = $1', [caseId])))!.ref
    const room = (await teamRoom(owner, 'store')).filter(m => m.caseRef === ref)
    const h = room.find(m => m.kind === 'handoff')!
    expect(h).toBeTruthy()
    expect(h.to?.id).toBe('store:listing_writer')
    expect(h.text).toMatch(/this one is yours: Blue mug has no description\. Listings are the Listing Writer’s job/)
    expect(room.find(m => m.kind === 'found')?.text).toBe('I found something: Blue mug has no description')
  })

  it('the chat gives tasks: "<agent>, please ..." in the team chat or "task: ..." to one agent', async () => {
    expect(intentOf('Room Helper, please call the Smiths').intent).toBe('delegate')
    expect(intentOf('task: order filters').intent).toBe('delegate')
    expect(intentOf('can you chase the supplier').intent).toBe('delegate')
    expect(intentOf('status').intent).toBe('status')
    expect(intentOf('please pause').intent).toBe('pause')
    expect(intentOf('hello there').intent).toBe('unknown')
    const one = await chat(owner, REF, 'task: order 20 filters')
    expect(one.messages[1].text).toMatch(/^Task DC-\d{6} given to Room Helper\./)
    const team = await chat(owner, null, 'Room Helper, please book the van for Friday', { workspace: 'office' })
    expect(team.messages[1].text).toMatch(/^Task DC-\d{6} given to Room Helper\./)
    const tasks = await admin(db => db.query<{ problem: string }>(`select problem from cases where org_id = $1 and kind = 'owner_task' order by opened_at`, [NW.org]))
    expect(tasks.map(t => t.problem)).toEqual(['order 20 filters', 'please book the van for Friday'])
    const nobody = await chat(owner, null, 'please sort the garage', { workspace: 'office' })
    expect(nobody.messages[1].text).toMatch(/^Which agent should take it\?/)
    // the team conversation is in the room too
    const room = await teamRoom(owner, 'office')
    expect(room.some(m => m.kind === 'chat' && m.from.kind === 'owner' && m.text === 'please sort the garage')).toBe(true)
    // a task given in the chat shows once in the room: as the task (and the agent picking it up), not also as the chat line
    expect(room.filter(m => m.text.includes('please book the van for Friday')).map(m => m.kind)).toEqual(['task', 'picked_up'])
  })

  it('what the team learned: nothing when Deploi never read the business; real numbers from the last read otherwise', async () => {
    await admin(db => db.query(`delete from discovery_runs where org_id = $1`, [HB.org]))
    expect(await learned(await merchantActor(HB))).toBeNull()
    const started = new Date(Date.now() - 60_000), finished = new Date(started.getTime() + 42_000)
    const prev = await admin(db => db.one<{ profile: unknown }>('select profile from business_profiles where org_id = $1', [NW.org]))
    await admin(async db => {
      const r = await db.one<{ id: string }>(`insert into discovery_runs (org_id, trigger, status, sources, findings_count, cases_opened, created_by, started_at, finished_at)
        values ($1, 'connection', 'partial', $2, 7, 3, 'test:team-room', $3, $4) returning id`, [NW.org,
        JSON.stringify([{ app: 'shopify', label: 'Shopify', status: 'read' }, { app: 'quickbooks', label: 'QuickBooks', status: 'not_read', reason: 'needs reconnecting' }]), started.toISOString(), finished.toISOString()])
      await db.query(`insert into business_profiles (org_id, run_id, profile) values ($1,$2,$3) on conflict (org_id) do update set run_id = excluded.run_id, profile = excluded.profile`, [NW.org, r!.id,
        JSON.stringify({ builtAt: finished.toISOString(), platforms: [], facts: [{ key: 'products', label: 'Products', value: 38, source: 'shopify', observedAt: finished.toISOString() }, { key: 'orders', label: 'Orders (30 days)', value: 250, capped: true, source: 'shopify', observedAt: finished.toISOString() }], notRead: [] })])
    })
    try {
      const l = (await learned(owner))!
      expect(l).toMatchObject({ seconds: 42, status: 'partial', read: ['Shopify'], findings: 7, casesOpened: 3 })
      expect(l.facts).toEqual([{ label: 'Products', value: '38' }, { label: 'Orders (30 days)', value: 'at least 250' }])
      expect(l.notRead).toEqual([{ label: 'QuickBooks', reason: 'needs reconnecting' }])
      expect(l.packs).toContain('Home services')
      const room = await teamRoom(owner, 'office')
      expect(room.some(m => m.kind === 'learned' && m.text === 'I read your business in 42 seconds (Shopify): 7 things found, 3 handed to the team.')).toBe(true)
    } finally {
      await admin(db => prev ? db.query('update business_profiles set profile = $2 where org_id = $1', [NW.org, JSON.stringify(prev.profile)]) : db.query('delete from business_profiles where org_id = $1', [NW.org]))
    }
  })
})
