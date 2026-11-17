/**
 * The redesigned app's data layer (lib/app/contract.ts), on the real database: the workspace switch (default,
 * persisted, feeds filtered), needs-you decided through the existing approval logic and then shown done with its
 * proof, the per-agent autonomy level and its effect on the loop, the money guard, standing instructions (CRUD and
 * the loop receiving them), empty states for a fresh organization, persisted agent colours, the chat intents,
 * the agent dashboard, and the privacy and retention coverage of the new tables.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { uuidFrom } from '../../lib/ids'
import type { Actor } from '../../lib/engine/actor'
import {
  PALETTE, getWorkspace, setWorkspace, commandCenter, needsYou, decideNeedsYou, doneWithProof, team, hero, allowance, agentDashboard,
  setAgentAutonomy, listInstructions, addInstruction, updateInstruction, deleteInstruction, chat, chatHistory, instructionsFor,
} from '../../lib/app/contract'
import { runAgentLoop, registerLoopResumer, LOOP_RESUME_JOB, type LoopSpec, type LoopContext } from '../../lib/events/loop'
import { setMode } from '../../lib/autonomy/settings'
import { registerPackAgents } from '../../lib/packs/registry'
import { runDueJobs } from '../../lib/jobs'
import '../../lib/cases/jobs'
import { collectCustomerData, redactCustomerData } from '../../lib/privacy/customer-data'
import { runRetention } from '../../lib/platform/retention'
import { NW, merchantActor } from '../merchant/helpers'
import { person, removePeople } from '../platform/helpers'
import { captureNotify, releaseNotify, sent, cleanW1 } from '../autonomy/helpers'

const ready = await prepareDb()

const KEY = 'rd_fixer'
const REF = `pack:${KEY}`
registerPackAgents([{ key: KEY, name: 'Fixer Test', pack: 'home_services', job: 'Fixes test records.', triggers: ['sweep'], actions: ['update_record'], status: 'working', shopifyReady: false }])

type World = { broken: Set<string>; acts: number; seen: string[][] }
let world: World
const fresh = (): World => ({ broken: new Set(['rd:1', 'rd:2', 'rd:3', 'rd:money']), acts: 0, seen: [] })
function spec(problemKey = 'rd:1', actionType = 'update_record'): LoopSpec<{ k: string }> {
  return {
    orgId: NW.org, agentKey: KEY, agentName: 'Fixer Test', actionType, problemKey,
    detect: async (_db, ctx: LoopContext) => { world.seen.push(ctx.instructions); return world.broken.has(problemKey) ? { k: problemKey } : null },
    describe: p => ({ title: `Record ${p.k} is wrong`, whatHappened: `Record ${p.k} shows the wrong value.`, whatIDid: [`Set record ${p.k} back.`] }),
    act: async (_db, p) => { world.acts++; world.broken.delete(p.k); return { proof: [{ label: 'Changed', value: `${p.k}: fixed` }] } },
    verify: async (_db, p) => ({ ok: !world.broken.has(p.k), proof: [{ label: `Fresh read of ${p.k}`, value: world.broken.has(p.k) ? 'wrong' : 'right' }] }),
  }
}
const run = (problemKey?: string, actionType?: string) => admin(db => runAgentLoop(db, spec(problemKey, actionType)))

let savedPacks: Record<string, unknown> | null = null
async function cleanApp() {
  await admin(async db => {
    for (const t of ['agent_profiles', 'agent_instructions', 'app_workspace_prefs', 'agent_chat_messages']) await db.query(`delete from ${t} where org_id = $1`, [NW.org])
    await db.query(`delete from library_auto_run_grants where org_id = $1`, [NW.org])
    await db.query(`delete from library_switches where org_id = $1 and agent_key = 'listing_writer'`, [NW.org])
    await db.query(`delete from cases where org_id = $1 and kind = 'agent_action'`, [NW.org])
  })
}

describe.skipIf(!ready)('redesigned app: data layer', () => {
  let owner: Actor
  beforeAll(async () => {
    savedPacks = await admin(db => db.one<Record<string, unknown>>('select * from pack_settings where org_id = $1', [NW.org]))
    await admin(db => db.query(`insert into pack_settings (org_id, business_type, packs, updated_by) values ($1, 'home_services', '{home_services}', 'test')
      on conflict (org_id) do update set business_type = 'home_services', packs = '{home_services}'`, [NW.org]))
    owner = await merchantActor(NW)
  })
  beforeEach(async () => { await cleanW1(); await cleanApp(); world = fresh(); captureNotify() })
  afterAll(async () => {
    releaseNotify(); await cleanW1(); await cleanApp(); await removePeople(NW)
    await admin(async db => {
      await db.query('delete from pack_settings where org_id = $1', [NW.org])
      if (savedPacks) await db.query(`insert into pack_settings (org_id, business_type, packs, trade, settings, updated_by, source) values ($1,$2,$3,$4,$5,$6,$7)`,
        [NW.org, savedPacks.business_type, savedPacks.packs, savedPacks.trade, JSON.stringify(savedPacks.settings ?? {}), savedPacks.updated_by, savedPacks.source ?? 'owner'])
    })
  })

  it('workspace: store by default for a store; the choice persists per person; every feed returns only that side', async () => {
    expect(await getWorkspace(owner)).toEqual({ workspace: 'store', default: 'store', chosen: false })
    expect(await setWorkspace(owner, 'office')).toEqual({ workspace: 'office' })
    expect(await getWorkspace(owner)).toEqual({ workspace: 'office', default: 'store', chosen: true })
    // another person of the same organization keeps their own view
    const member = await person(NW, 'member', 'rd-member')
    expect((await getWorkspace(member)).workspace).toBe('store')
    await expect(setWorkspace(owner, 'garage')).rejects.toMatchObject({ code: 'invalid_input' })

    const store = await team(owner, 'store')
    const office = await team(owner, 'office')
    expect(store.length).toBeGreaterThan(0)
    expect(store.every(a => a.id.startsWith('store:') && a.workspace === 'store' && a.kind === 'store')).toBe(true)
    expect(store.map(a => a.id)).toContain('store:inventory_watcher')
    expect(office.length).toBeGreaterThan(0)
    expect(office.every(a => a.workspace === 'office' && !a.id.startsWith('store:'))).toBe(true)
    expect(office.map(a => a.id)).toContain(REF)

    // a loop of the office-side agent: only the office feeds show it
    await setAgentAutonomy(owner, REF, 'ask_first')
    await run('rd:1')
    expect((await needsYou(owner, 'office')).map(i => i.agent.id)).toContain(REF)
    expect((await needsYou(owner, 'store')).some(i => i.agent.id === REF)).toBe(false)
    const cc = await commandCenter(owner, 'store')
    expect(cc.workspace).toBe('store')
    expect(cc.team.every(a => a.workspace === 'store')).toBe(true)
    expect(cc.needsYou.every(i => i.workspace === 'store')).toBe(true)
  })

  it('agent colours: assigned round-robin from the palette on first sight and kept', async () => {
    const first = await team(owner, 'store')
    const rows = await admin(db => db.query<{ agent_ref: string; seq: number; color: string }>('select agent_ref, seq, color from agent_profiles where org_id = $1 order by seq', [NW.org]))
    expect(rows.length).toBeGreaterThan(first.length) // both sides were seen
    rows.forEach((r, i) => { expect(r.seq).toBe(i); expect(r.color).toBe(PALETTE[i % PALETTE.length]) })
    for (const a of first) expect(a.color).toBe(rows.find(r => r.agent_ref === a.id)!.color)
    // stored, not recomputed: a changed colour stays
    await admin(db => db.query(`update agent_profiles set color = '#14B8A6' where org_id = $1 and agent_ref = 'store:inventory_watcher'`, [NW.org]))
    expect((await team(owner, 'store')).find(a => a.id === 'store:inventory_watcher')!.color).toBe('#14B8A6')
    expect((await admin(db => db.query('select agent_ref from agent_profiles where org_id = $1', [NW.org]))).length).toBe(rows.length)
  })

  it('needs you: approve through the new entry point resolves through the existing approval logic, then it is done with a proof link; decline does nothing', async () => {
    await setAgentAutonomy(owner, REF, 'ask_first')
    expect(await run('rd:1')).toMatchObject({ status: 'waiting_for_owner' })
    expect(world.acts).toBe(0)
    const [item] = (await needsYou(owner, 'office')).filter(i => i.agent.id === REF)
    expect(item).toMatchObject({ source: 'agent_action', agent: { id: REF, name: 'Fixer Test', color: expect.stringMatching(/^#/) }, title: 'Record rd:1 is wrong', money: false,
      primaryAction: 'Approve', secondaryAction: 'Decline', decisions: ['approve', 'decline'], caseRef: expect.stringMatching(/^DC-/), ago: 'just now', workspace: 'office' })
    expect(item.explanation).toMatch(/Record rd:1 shows the wrong value\. Set record rd:1 back\. Nothing is done until you decide\./)
    expect(item.id).toBe(`agent_action:${item.itemId}`)
    // members cannot approve (the registry's role check), unknown ids are not found
    const member = await person(NW, 'member', 'rd-approve-member')
    await expect(decideNeedsYou(member, item.id, 'approve')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(decideNeedsYou(owner, 'agent_action:00000000-0000-0000-0000-000000000000', 'approve')).rejects.toMatchObject({ code: 'not_found' })
    await expect(decideNeedsYou(owner, item.id, 'maybe')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(decideNeedsYou(owner, item.id, 'approve', { amount: 10 })).rejects.toMatchObject({ code: 'invalid_input' })

    registerLoopResumer(KEY, async r => (r.problemKey.startsWith('rd:') ? spec(r.problemKey) : null))
    expect(await decideNeedsYou(owner, item.id, 'approve')).toMatchObject({ id: item.id, decision: 'approve', status: 'approved', source: 'agent_action' })
    await runDueJobs({ kinds: [LOOP_RESUME_JOB] })
    expect(world.acts).toBe(1)
    expect((await needsYou(owner, 'office')).some(i => i.id === item.id)).toBe(false)
    const done = (await doneWithProof(owner, 'office')).find(d => d.agent.id === REF)!
    expect(done).toMatchObject({ what: 'Record rd:1 is wrong', proof: { label: 'Before / after', href: `/store/work/${item.caseRef}` }, onItsOwn: false, workspace: 'office' })
    expect((await doneWithProof(owner, 'store')).some(d => d.agent.id === REF)).toBe(false)

    // decline: nothing is done, it leaves the list and is not "done"
    await run('rd:2')
    const second = (await needsYou(owner, 'office')).find(i => i.agent.id === REF)!
    expect(await decideNeedsYou(owner, second.id, 'decline')).toMatchObject({ status: 'rejected' })
    expect(world.acts).toBe(1)
    expect((await needsYou(owner, 'office')).some(i => i.agent.id === REF)).toBe(false)
    expect((await doneWithProof(owner, 'office')).filter(d => d.agent.id === REF)).toHaveLength(1)
  })

  it('autonomy: saved per agent, owners and admins only, and it governs the loop (ask_first waits; autonomous acts over an org ask_first and tells in the summary only)', async () => {
    const member = await person(NW, 'member', 'rd-autonomy-member')
    await expect(setAgentAutonomy(member, REF, 'autonomous')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(setAgentAutonomy(owner, REF, 'sometimes')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(setAgentAutonomy(owner, 'pack:not_an_agent', 'ask_first')).rejects.toMatchObject({ code: 'not_found' })
    // default: no level chosen, the organization's mode (act_and_tell) applies
    expect((await team(owner, 'office')).find(a => a.id === REF)).toMatchObject({ autonomy: 'act_then_tell', autonomyChosen: false })
    expect(await run('rd:1')).toMatchObject({ status: 'done', mode: 'act_and_tell' })

    expect(await setAgentAutonomy(owner, REF, 'ask_first')).toMatchObject({ agentId: REF, autonomy: 'ask_first', changed: true })
    expect((await team(owner, 'office')).find(a => a.id === REF)).toMatchObject({ autonomy: 'ask_first', autonomyChosen: true, status: 'watching' })
    expect(await run('rd:2')).toMatchObject({ status: 'waiting_for_owner' })
    expect(world.acts).toBe(1)
    expect((await team(owner, 'office')).find(a => a.id === REF)).toMatchObject({ status: 'waiting', doingNow: 'Waiting for you: Record rd:2 is wrong' })

    // the organization asks first for this action type, the agent's own level overrides it
    await setMode(owner, 'update_record', 'ask_first')
    await setAgentAutonomy(owner, REF, 'autonomous')
    sent.length = 0
    expect(await run('rd:3')).toMatchObject({ status: 'done' })
    expect(world.acts).toBe(2)
    expect(sent.find(u => u.severity === 'info')).toMatchObject({ digest: true })
    const audit = await admin(db => db.query<{ detail: { to: string } }>(`select detail from engine_audit where org_id = $1 and event = 'app.agent_autonomy' order by id desc limit 1`, [NW.org]))
    expect(audit[0].detail.to).toBe('autonomous')
  })

  it('autonomy of a store library agent: its permission and auto-run grants follow the level', async () => {
    const id = 'store:listing_writer'
    const r = await setAgentAutonomy(owner, id, 'act_then_tell')
    expect(r.applied).toEqual(expect.arrayContaining(['library permission: act', 'auto-run: Draft an improved title', 'auto-run: Draft an improved description']))
    const sw = await admin(db => db.one<{ permission: string; enabled: boolean }>(`select permission, enabled from library_switches where org_id = $1 and agent_key = 'listing_writer'`, [NW.org]))
    // still switched on (it ran by default): setting its level never turns it off
    expect(sw).toMatchObject({ permission: 'act', enabled: true })
    expect((await team(owner, 'store')).find(a => a.id === id)).toMatchObject({ autonomy: 'act_then_tell', autonomyChosen: true })
    expect(await admin(db => db.query(`select action_type from library_auto_run_grants where org_id = $1 and agent_key = 'listing_writer' and revoked_at is null order by action_type`, [NW.org]))).toEqual([{ action_type: 'draft_description' }, { action_type: 'draft_title' }])
    await setAgentAutonomy(owner, id, 'ask_first')
    expect((await admin(db => db.one<{ permission: string }>(`select permission from library_switches where org_id = $1 and agent_key = 'listing_writer'`, [NW.org])))!.permission).toBe('draft')
    expect(await admin(db => db.query(`select 1 from library_auto_run_grants where org_id = $1 and agent_key = 'listing_writer' and revoked_at is null`, [NW.org]))).toEqual([])
  })

  it('money guard: an autonomous agent still waits for the owner on a money action; a non-money action acts', async () => {
    await setAgentAutonomy(owner, REF, 'autonomous')
    const money = await run('rd:money', 'refund')
    expect(money).toMatchObject({ status: 'waiting_for_owner' })
    expect(world.acts).toBe(0)
    const l = await admin(db => db.one<{ mode: string; state: string; action: { money: boolean } }>(`select mode, state, action from agent_loops where org_id = $1 and problem_key = 'rd:money'`, [NW.org]))
    expect(l).toMatchObject({ mode: 'ask_first', state: 'awaiting_owner', action: { money: true } })
    const item = (await needsYou(owner, 'office')).find(i => i.agent.id === REF)!
    expect(item).toMatchObject({ money: true, primaryAction: 'Approve refund' })
    for (const t of ['payment', 'purchase_order', 'reorder', 'discount', 'credit_note']) {
      world.broken.add(`rd:${t}`)
      expect(await run(`rd:${t}`, t), t).toMatchObject({ status: 'waiting_for_owner' })
    }
    expect(world.acts).toBe(0)
    expect(await run('rd:1')).toMatchObject({ status: 'done' })
    expect(world.acts).toBe(1)
  })

  it('standing instructions: add, edit, reorder, delete (owners and admins); the loop receives them and notes them on the case', async () => {
    const member = await person(NW, 'member', 'rd-instr-member')
    await expect(addInstruction(member, REF, { text: 'Never on Sundays' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(addInstruction(owner, REF, { text: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(addInstruction(owner, REF, { text: '   ' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(addInstruction(owner, 'pack:nobody_here', { text: 'Hello' })).rejects.toMatchObject({ code: 'not_found' })
    const a = await addInstruction(owner, REF, { text: 'Never contact customers on Sundays' })
    const b = await addInstruction(owner, REF, { text: 'Copy the office manager' })
    expect([a.position, b.position]).toEqual([0, 1])
    expect(await updateInstruction(owner, REF, a.id, { text: 'Never contact customers before 9am' })).toMatchObject({ id: a.id, text: 'Never contact customers before 9am' })
    await updateInstruction(owner, REF, a.id, { position: 5 })
    expect((await listInstructions(member, REF)).map(i => i.text)).toEqual(['Copy the office manager', 'Never contact customers before 9am'])
    await expect(updateInstruction(owner, 'pack:other', a.id, { text: 'x' })).rejects.toMatchObject({ code: 'not_found' })
    expect(await instructionsFor(NW.org, REF)).toEqual(['Copy the office manager', 'Never contact customers before 9am'])

    await run('rd:1')
    expect(world.seen[0]).toEqual(['Copy the office manager', 'Never contact customers before 9am'])
    const l = await admin(db => db.one<{ action: { instructions: string[] }; case_id: string }>(`select action, case_id from agent_loops where org_id = $1 and problem_key = 'rd:1'`, [NW.org]))
    expect(l!.action.instructions).toEqual(['Copy the office manager', 'Never contact customers before 9am'])
    const note = await admin(db => db.one<{ summary: string }>(`select summary from case_events where case_id = $1 and type = 'note'`, [l!.case_id]))
    expect(note!.summary).toBe('Standing instructions: "Copy the office manager"; "Never contact customers before 9am"')

    expect(await deleteInstruction(owner, REF, b.id)).toEqual({ deleted: true })
    await expect(deleteInstruction(owner, REF, b.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(await instructionsFor(NW.org, REF)).toEqual(['Never contact customers before 9am'])
    // the agent page shows them
    expect((await agentDashboard(owner, REF)).instructions.map(i => i.text)).toEqual(['Never contact customers before 9am'])
  })

  it('chat: status, today, what needs me (with buttons), set autonomy, pause and resume from real data; honest when it cannot answer; history stored', async () => {
    await setAgentAutonomy(owner, REF, 'ask_first')
    await run('rd:1')
    let r = await chat(owner, REF, 'What are you doing?')
    expect(r.messages.map(m => m.role)).toEqual(['owner', 'agent'])
    expect(r.messages[1].text).toMatch(/^Fixer Test: Waiting for you: Record rd:1 is wrong\. 0 actions today\. I ask you first\.$/)
    r = await chat(owner, REF, 'anything that needs me?')
    expect(r.messages[1].text).toMatch(/1 thing needs you:\n- Fixer Test: Record rd:1 is wrong/)
    const item = (await needsYou(owner, 'office')).find(i => i.agent.id === REF)!
    expect(r.messages[1].actions).toEqual([{ label: 'Approve', needsYouId: item.id, decision: 'approve' }, { label: 'Decline', needsYouId: item.id, decision: 'decline' }])
    r = await chat(owner, REF, 'what did you do today?')
    expect(r.messages[1].text).toBe('Fixer Test has not finished anything yet today.')
    r = await chat(owner, REF, 'just do it and tell me after')
    expect(r.messages[1].text).toMatch(/Fixer Test will now do it and tell you after\. Anything that moves money still waits/)
    expect((await team(owner, 'office')).find(a => a.id === REF)).toMatchObject({ autonomy: 'act_then_tell', autonomyChosen: true })
    r = await chat(owner, REF, 'pause please')
    expect(r.messages[1].text).toMatch(/Fixer Test is paused/)
    expect(await run('rd:2')).toEqual({ status: 'nothing_to_do', reason: 'paused' })
    expect((await team(owner, 'office')).find(a => a.id === REF)).toMatchObject({ status: 'off', doingNow: 'Paused by you' })
    r = await chat(owner, REF, 'resume')
    expect(r.messages[1].text).toBe('Fixer Test is back on.')
    expect(await run('rd:2')).toMatchObject({ status: 'done' })
    r = await chat(owner, REF, 'what is the meaning of life?')
    expect(r.messages[1].text).toMatch(/^I can't answer that without AI turned on; here is what I can do: /)
    // a member may ask but not change the agent
    const member = await person(NW, 'member', 'rd-chat-member')
    expect((await chat(member, REF, 'pause')).messages[1].text).toMatch(/^I can't do that for you: /)
    // the team chat answers for the whole side, and names an agent for actions
    r = await chat(owner, null, 'status', { workspace: 'office' })
    expect(r.messages[1].text).toMatch(/agents? running\.[\s\S]*Fixer Test: /)
    expect((await chat(owner, null, 'pause', { workspace: 'office' })).messages[1].text).toMatch(/^Which agent\?/)
    await expect(chat(owner, REF, '')).rejects.toMatchObject({ code: 'invalid_input' })
    const history = await chatHistory(owner, REF)
    expect(history.length).toBe(16)
    expect(history[0]).toMatchObject({ role: 'owner', text: 'What are you doing?', agentId: REF })
    expect(history[1].role).toBe('agent')
    expect((await chatHistory(owner, null)).map(m => m.role)).toEqual(['owner', 'agent', 'owner', 'agent'])
  })

  it('agent dashboard: four stats per kind, scopes from real grants (money asks), work with proof', async () => {
    const d = await agentDashboard(owner, 'store:inventory_watcher')
    expect(d.agent).toMatchObject({ id: 'store:inventory_watcher', kind: 'store', name: 'Inventory Watcher', area: 'Inventory', workspace: 'store' })
    expect(d.stats.map(s => s.key)).toEqual(['products_watched', 'sellouts_prevented_30d', 'time_saved_week', 'actions_month'])
    expect(d.stats.every(s => Number.isInteger(s.value) && s.value >= 0)).toBe(true)
    expect(d.scopes).toEqual(expect.arrayContaining([{ label: 'Read your store', level: 'read' }, { label: 'Reorder stock from a supplier', level: 'ask' }]))
    await run('rd:1')
    const p = await agentDashboard(owner, REF)
    expect(p.stats.map(s => s.key)).toEqual(['handled_30d', 'waiting', 'time_saved_week', 'actions_month'])
    expect(p.stats.find(s => s.key === 'handled_30d')!.value).toBe(1)
    expect(p.scopes).toEqual([{ label: 'Update record', level: 'act' }])
    expect(p.work[0]).toMatchObject({ what: 'Record rd:1 is wrong', result: 'Done, verified', proof: { label: 'Before / after', href: expect.stringMatching(/^\/store\/work\/DC-/) } })
    await expect(agentDashboard(owner, 'office:00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('staff are refused (they use the staff console)', async () => {
    const { staffActor } = await import('../merchant/helpers')
    const staff = await staffActor()
    await expect(commandCenter(staff, 'store')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(getWorkspace(staff)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('privacy and retention: chat and instructions naming a shopper are exported and erased; old chat is purged', async () => {
    const email = 'rd.shopper@buyer.example'
    await addInstruction(owner, REF, { text: `Never email ${email} again` })
    await chat(owner, REF, `did ${email} write?`)
    const subject = { orgId: NW.org, email, customerId: null, orderIds: [] }
    const ex = await admin(db => collectCustomerData(db, subject, NW.domain))
    expect(ex.counts.agent_chat_messages).toBe(1)
    expect(ex.counts.agent_instructions).toBe(1)
    const out = await admin(db => redactCustomerData(db, subject))
    expect(out).toMatchObject({ agent_chat_messages: 1, agent_instructions: 1 })
    expect(await instructionsFor(NW.org, REF)).toEqual(['Never email [erased] again'])
    await admin(db => db.query(`insert into agent_chat_messages (org_id, agent_ref, role, text, created_at) values ($1,$2,'owner','old message', now() - interval '400 days')`, [NW.org, REF]))
    expect((await runRetention()).agentChatDeleted).toBeGreaterThanOrEqual(1)
    expect(await admin(db => db.query(`select 1 from agent_chat_messages where org_id = $1 and text = 'old message'`, [NW.org]))).toEqual([])
  })
})

describe.skipIf(!ready)('redesigned app: a fresh organization', () => {
  const ORG = uuidFrom('org:redesign:fresh')
  const UID = uuidFrom('user:redesign:fresh')
  const EMAIL = 'owner@redesign-fresh.example'
  let actor: Actor
  beforeAll(async () => {
    await admin(async db => {
      await db.query(`insert into agencies (id, name, state, org_type) values ($1, 'Fresh Redesign Co', '', 'merchant') on conflict (id) do nothing`, [ORG])
      await db.query('insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing', [UID, EMAIL])
      await db.query(`insert into profiles (id, email, role, agency_id, org_role) values ($1,$2,'client',$3,'owner') on conflict (id) do update set agency_id = excluded.agency_id, org_role = 'owner'`, [UID, EMAIL, ORG])
      await db.query(`update profiles set org_role = 'owner' where id = $1`, [UID])
    })
    actor = { kind: 'profile', session: { uid: UID, email: EMAIL, role: 'client', agencyId: ORG, orgType: 'merchant' }, orgId: ORG, label: `user:${EMAIL}` }
  })
  afterAll(async () => { await admin(async db => { await db.query('delete from auth.users where id = $1', [UID]); await db.query('delete from agencies where id = $1', [ORG]) }) })

  it('every feed is empty (no fake rows), nothing is invented; the default side follows the products', async () => {
    // a new organization starts with the commerce product: store, until it turns Deploi Office on without a store
    expect(await getWorkspace(actor)).toEqual({ workspace: 'store', default: 'store', chosen: false })
    await admin(db => db.query(`insert into org_products (org_id, product, enabled_by) values ($1, 'office', 'test') on conflict (org_id, product) do update set status = 'active'`, [ORG]))
    expect(await getWorkspace(actor)).toEqual({ workspace: 'office', default: 'office', chosen: false })
    for (const ws of ['store', 'office'] as const) {
      const cc = await commandCenter(actor, ws)
      expect(cc).toMatchObject({ workspace: ws, needsYou: [], doneWithProof: [], team: [] })
      expect(cc.hero).toEqual({ agentsRunning: 0, lastCheckAt: null, handledSinceYesterday: 0, needYouCount: 0, timeSavedWeekMinutes: 0, timeSavedFormula: 'no agents yet', fixedOnTheirOwn: 0 })
      expect(await needsYou(actor, ws)).toEqual([])
      expect(await doneWithProof(actor, ws, 10)).toEqual([])
      expect(await team(actor, ws)).toEqual([])
      expect((await hero(actor, ws)).agentsRunning).toBe(0)
    }
    expect(await allowance(actor)).toMatchObject({ used: 0, limit: null, planName: 'Free beta', enforced: false, resetsAt: expect.stringMatching(/T00:00:00\.000Z$/) })
    expect(await admin(db => db.query('select 1 from agent_profiles where org_id = $1', [ORG]))).toEqual([])
    expect(await chatHistory(actor, null)).toEqual([])
    expect((await chat(actor, null, 'status', { workspace: 'office' })).messages[1].text).toBe('There are no agents on this side yet. Connect a system and the team starts on its own.')
    expect((await chat(actor, null, 'what needs me', { workspace: 'office' })).messages[1].text).toBe('Nothing needs you right now.')
  })
})

describe.skipIf(!ready)('redesigned app: an Office agent', () => {
  let officeBefore: { status: string } | null = null
  beforeAll(async () => { officeBefore = await admin(db => db.one<{ status: string }>(`select status from org_products where org_id = $1 and product = 'office'`, [NW.org])) })
  afterAll(async () => {
    const { resetOffice } = await import('../office/helpers')
    await resetOffice(NW, { enable: officeBefore?.status === 'active' })
    if (!officeBefore) await admin(db => db.query(`delete from org_products where org_id = $1 and product = 'office'`, [NW.org]))
    await admin(async db => { for (const t of ['agent_profiles', 'agent_instructions']) await db.query(`delete from ${t} where org_id = $1`, [NW.org]) })
  })

  it('is on the office team; its autonomy re-grants its tool tiers through the existing grant path, as the owner; its run carries its instructions', async () => {
    const { setupOffice, grantedAgent } = await import('../office/helpers')
    const { runOfficeAgent } = await import('../../lib/office/run')
    const s = await setupOffice(NW)
    const agentId = await grantedAgent(s, 'lead_followup', { email: 'send_approved' }, undefined, 'Lead chaser')
    const id = `office:${agentId}`
    const member = (await team(s.actor, 'office')).find(a => a.id === id)!
    expect(member).toMatchObject({ kind: 'office', name: 'Lead chaser', area: 'Leads', workspace: 'office', autonomy: 'ask_first', autonomyChosen: false, status: 'watching' })
    expect((await team(s.actor, 'store')).some(a => a.id === id)).toBe(false)
    const tiers = () => admin(db => db.one<{ email: string; crm: string; until: string | null; granted_by: string; version: number }>(
      `select p.policy->'email'->>'tier' as email, p.policy->'crm'->>'tier' as crm, p.policy->'email'->>'validUntil' as until, p.granted_by, p.version from office_agents a join office_agent_policies p on p.id = a.active_policy_id where a.id = $1`, [agentId]))
    const r = await setAgentAutonomy(s.actor, id, 'act_then_tell')
    expect(r.applied.join(' ')).toMatch(/Office tools: acts within its limits for a year \(version 2\)/)
    const t = (await tiers())!
    expect(t).toMatchObject({ email: 'send_autonomous', granted_by: s.actor.label, version: 2 })
    expect(new Date(t.until!).getTime()).toBeGreaterThan(Date.now() + 300 * 864e5)
    expect((await agentDashboard(s.actor, id)).scopes).toEqual(expect.arrayContaining([{ label: 'Send email', level: 'act' }, { label: 'Read your CRM', level: 'read' }, { label: 'Read the mailbox', level: 'read' }]))
    await setAgentAutonomy(s.actor, id, 'ask_first')
    expect(await tiers()).toMatchObject({ email: 'send_approved', until: null, version: 3 })
    expect((await agentDashboard(s.actor, id)).scopes).toEqual(expect.arrayContaining([{ label: 'Send email', level: 'ask' }]))

    await addInstruction(s.actor, id, { text: 'Mention the spring catalogue' })
    const run = await runOfficeAgent(agentId, { trigger: 'test' })
    const row = await admin(db => db.one<{ instructions: string[] }>('select instructions from office_runs where id = $1', [run.runId]))
    expect(row!.instructions).toEqual(['Mention the spring catalogue'])
  })
})
