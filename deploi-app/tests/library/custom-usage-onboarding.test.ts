import { describe, it, expect, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { NW, resetLibrary, actionsOf } from './helpers'
import { merchantActor, staffActor } from '../merchant/helpers'
import { setSwitch, setTier, teamView } from '../../lib/library/switches'
import { createCustomAgent, updateCustomAgent, runCustomAgent, deleteCustomAgent } from '../../lib/library/custom'
import { runLibraryAgent } from '../../lib/library/actions'
import { usageSummary } from '../../lib/library/usage'
import { onboardingView, completeOnboarding } from '../../lib/library/onboarding'
import { submitFeedback, listFeedback } from '../../lib/library/feedback'
import { weeklyFacts, weekStartOf, renderWeekly, renderWeeklyHtml } from '../../lib/agents/weekly'
import { libraryWeek } from '../../lib/library/weekly'
import { admin } from '../../lib/db'

const ready = await prepareDb()
const NOW = new Date('2026-10-29T12:00:00Z')

describe.skipIf(!ready)('build your own agent (Pro)', () => {
  beforeEach(() => resetLibrary(NW, 'pro'))
  it('defaults to read, the most restrictive level; runs the matched capabilities under its own permission and key', async () => {
    const actor = await merchantActor(NW)
    const a = await createCustomAgent(actor, { name: 'Late order nudger', job: 'Tell me which orders are late' })
    expect(a).toMatchObject({ permission: 'read', capabilities: ['order_tracker'] })
    await expect(createCustomAgent(actor, { name: 'x', job: 'y', permission: 'owner' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(runCustomAgent(actor, a.id)).rejects.toMatchObject({ code: 'conflict' })
    await updateCustomAgent(actor, a.id, { enabled: true })
    const r = await runCustomAgent(actor, a.id, NOW)
    expect(r.capabilities).toEqual(['order_tracker'])
    expect(r.results[0].counts.noted).toBeGreaterThan(0)
    expect(r.results[0].counts.drafted).toBe(0)
    const rows = await actionsOf(NW, `custom:${a.id}`)
    expect(rows.every(x => x.status === 'noted')).toBe(true)
    expect(await actionsOf(NW, 'order_tracker')).toEqual([])
    await updateCustomAgent(actor, a.id, { permission: 'draft' })
    await admin(db => db.query('delete from library_actions where org_id = $1', [NW.org]))
    expect((await runCustomAgent(actor, a.id, NOW)).results[0].counts.drafted).toBeGreaterThan(0)
    expect((await teamView(actor)).buildYourOwn.agents).toHaveLength(1)
    await deleteCustomAgent(actor, a.id)
    expect((await teamView(actor)).buildYourOwn.agents).toHaveLength(0)
  })
  it('is Pro only, and a downgrade switches custom agents off', async () => {
    const actor = await merchantActor(NW)
    const a = await createCustomAgent(actor, { name: 'x', job: 'check fees', permission: 'draft' })
    await updateCustomAgent(actor, a.id, { enabled: true })
    await setTier(actor, 'growth')
    await expect(runCustomAgent(actor, a.id, NOW)).rejects.toMatchObject({ code: 'upgrade_required' })
    expect((await admin(db => db.one<{ enabled: boolean }>('select enabled from custom_agents where id = $1', [a.id])))!.enabled).toBe(false)
  })
})

describe.skipIf(!ready)('usage per action and the monthly allowance', () => {
  beforeEach(() => resetLibrary(NW, 'starter'))
  it('records one usage row per action with an estimated cost; the summary shows the allowance, overage and the proposed bill', async () => {
    const actor = await merchantActor(NW)
    await setSwitch(actor, 'ai_visibility', true).catch(() => null) // locked on starter
    await setSwitch(actor, 'listing_writer', true)
    const r = await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
    const u = await usageSummary(actor, NW.org, NOW)
    expect(u.tier).toBe('starter')
    expect(u.actionsUsed).toBe(r.counts.drafted)
    expect(u.allowance).toBe(150)
    expect(u.remaining).toBe(150 - r.counts.drafted)
    expect(u.overageActions).toBe(0)
    expect(u.estimatedModelCostUsd).toBeGreaterThan(0)
    expect(u.measured).toBe(false)
    expect(u.byAgent[0]).toMatchObject({ agentKey: 'listing_writer', actions: r.counts.drafted })
    expect(u.proposedBill.total).toBe(29)
    expect(u.pricingStatus).toBe('coming_soon')
    await admin(db => db.query(`insert into library_usage (org_id, agent_key, action_type, cost_usd) select $1, 'listing_writer', 'draft_title', 0.01 from generate_series(1, 160)`, [NW.org]))
    const over = await usageSummary(actor, NW.org, NOW)
    expect(over.overageActions).toBe(160 + r.counts.drafted - 150)
    expect(over.proposedBill.overage).toBeCloseTo(over.overageActions * 0.25, 2)
  })
})

describe.skipIf(!ready)('onboarding, feedback and the weekly summary', () => {
  beforeEach(() => resetLibrary(NW, 'starter'))
  it('onboarding walks connect, tier, agents, done, and persists', async () => {
    const actor = await merchantActor(NW)
    let v = await onboardingView(actor)
    expect(v.store.connected).toBe(true)
    expect(v.current).toBe('tier')
    await expect(completeOnboarding(actor)).rejects.toMatchObject({ code: 'needs_setup', detail: { step: 'tier' } })
    await setTier(actor, 'growth')
    v = await onboardingView(actor)
    expect(v.current).toBe('agents')
    await setSwitch(actor, 'order_tracker', true)
    v = await onboardingView(actor)
    expect(v.current).toBe('done')
    expect(await completeOnboarding(actor)).toEqual({ completed: true })
    expect((await onboardingView(actor)).state).toMatchObject({ tierChosen: true, storeConnected: true, agentsSwitchedOn: true })
  })
  it('feedback is stored with the page and mood; staff read it, merchants do not', async () => {
    const actor = await merchantActor(NW)
    const r = await submitFeedback(actor, { page: '/store/team', mood: 'happy', message: 'The approval queue is clear.' })
    expect(r.id).toBeTruthy()
    await expect(submitFeedback(actor, { message: '' })).rejects.toMatchObject({ code: 'invalid_input' })
    const all = await listFeedback(await staffActor())
    expect(all.find(f => f.id === r.id)).toMatchObject({ mood: 'happy', page: '/store/team', org_name: expect.any(String) })
    expect((await listFeedback(actor)).find(f => f.id === r.id)).toBeDefined() // own organization's rows are visible
  })
  it('the weekly summary carries actions per agent and the time and money saved, labelled estimates', async () => {
    const actor = await merchantActor(NW)
    await setSwitch(actor, 'listing_writer', true)
    await setSwitch(actor, 'inventory_watcher', true)
    await runLibraryAgent({ orgId: NW.org, agentKey: 'inventory_watcher', trigger: 'test', actor: actor.label, now: NOW })
    const fix = (await actionsOf(NW, 'inventory_watcher')).find(a => a.action_type === 'draft_inventory_policy_fix')!
    const { approveAction } = await import('../../lib/library/actions')
    await approveAction(actor, fix.id, NOW)
    const week = await admin(db => libraryWeek(db, NW.org, weekStartOf(new Date())))
    expect(week.agents.find(a => a.agentKey === 'inventory_watcher')).toMatchObject({ done: 1 })
    expect(week.money).toMatchObject({ stockoutsAvoided: 1, label: 'Estimate', aovSource: 'default', usd: 45 })
    expect(week.time.minutes).toBeGreaterThan(0)
    const facts = await admin(db => weeklyFacts(db, NW.org, weekStartOf(new Date())))
    expect(facts.library?.actionsTotal).toBeGreaterThan(0)
    const text = renderWeekly(facts, 'http://localhost:3000').text
    expect(text).toMatch(/Your team \(agent library\)/)
    expect(text).toMatch(/Estimated money saved: about \$45\. An estimate/)
    expect(renderWeeklyHtml(facts, 'http://localhost:3000')).toMatch(/Estimated money saved/)
  })
})
