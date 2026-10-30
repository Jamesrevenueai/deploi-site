import { describe, it, expect, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { NW, HB, resetLibrary } from './helpers'
import { merchantActor, staffActor } from '../merchant/helpers'
import { setSwitch, setTier, teamView, setPermission, grantAutoRun } from '../../lib/library/switches'
import { createCustomAgent } from '../../lib/library/custom'
import { LIBRARY } from '../../lib/library/config'
import { admin } from '../../lib/db'

const ready = await prepareDb()

describe.skipIf(!ready)('tier-gated access: the tier a merchant buys decides which agents can be switched on', () => {
  beforeEach(() => resetLibrary(NW, 'starter'))

  it('a Starter merchant sees all twelve agents; eight are locked with the tier that unlocks them', async () => {
    const actor = await merchantActor(NW)
    const t = await teamView(actor)
    expect(t.tier).toBe('starter')
    expect(t.agents).toHaveLength(12)
    const locked = t.agents.filter(a => a.locked)
    expect(locked).toHaveLength(8)
    expect(locked.find(a => a.key === 'order_tracker')!.upgradeTo).toBe('growth')
    expect(locked.find(a => a.key === 'customer_care')!.upgradeTo).toBe('pro')
    expect(t.agents.filter(a => !a.locked).map(a => a.key).sort()).toEqual(['inventory_watcher', 'listing_writer', 'store_health_checker', 'weekly_insights'])
    expect(t.buildYourOwn.allowed).toBe(false)
  })

  it('a locked agent cannot be switched on, have its permission raised, or be granted auto-run', async () => {
    const actor = await merchantActor(NW)
    await expect(setSwitch(actor, 'order_tracker', true)).rejects.toMatchObject({ code: 'upgrade_required', detail: { tier: 'starter', upgradeTo: 'growth', agentKey: 'order_tracker' } })
    await expect(setSwitch(actor, 'customer_care', true)).rejects.toMatchObject({ code: 'upgrade_required', detail: { upgradeTo: 'pro' } })
    await expect(setPermission(actor, 'returns', 'act')).rejects.toMatchObject({ code: 'upgrade_required' })
    await expect(grantAutoRun(actor, 'listing_writer', 'draft_title')).rejects.toMatchObject({ code: 'conflict' }) // unlocked, but not at "act" yet
    await expect(grantAutoRun(actor, 'returns', 'draft_return_reply')).rejects.toMatchObject({ code: 'upgrade_required' })
    expect((await teamView(actor)).agents.find(a => a.key === 'order_tracker')!.enabled).toBe(false)
  })

  it('an unlocked agent switches on and off', async () => {
    const actor = await merchantActor(NW)
    expect((await setSwitch(actor, 'listing_writer', true)).enabled).toBe(true)
    expect((await teamView(actor)).agents.find(a => a.key === 'listing_writer')!.enabled).toBe(true)
    expect((await setSwitch(actor, 'listing_writer', false)).enabled).toBe(false)
    expect((await teamView(actor)).agents.find(a => a.key === 'listing_writer')!.enabled).toBe(false)
  })

  it('upgrading unlocks: Growth unlocks Order Tracker, Pro unlocks everything and build your own', async () => {
    const actor = await merchantActor(NW)
    expect(await setTier(actor, 'growth')).toMatchObject({ from: 'starter', to: 'growth', switchedOff: [] })
    expect((await setSwitch(actor, 'order_tracker', true)).enabled).toBe(true)
    await expect(setSwitch(actor, 'returns', true)).rejects.toMatchObject({ code: 'upgrade_required', detail: { tier: 'growth', upgradeTo: 'pro' } })
    await expect(createCustomAgent(actor, { name: 'Mine', job: 'watch payouts' })).rejects.toMatchObject({ code: 'upgrade_required' })
    await setTier(actor, 'pro')
    const t = await teamView(actor)
    expect(t.agents.every(a => !a.locked)).toBe(true)
    expect(t.buildYourOwn.allowed).toBe(true)
    expect((await setSwitch(actor, 'returns', true)).enabled).toBe(true)
    expect((await createCustomAgent(actor, { name: 'Mine', job: 'watch payouts' })).permission).toBe('read')
  })

  it('downgrading switches off the agents the new tier does not include and expires their drafts', async () => {
    const actor = await merchantActor(NW)
    await setTier(actor, 'pro')
    await setSwitch(actor, 'order_tracker', true)
    await setSwitch(actor, 'listing_writer', true)
    await admin(db => db.query(`insert into library_actions (org_id, agent_key, action_type, title, mode, status) values ($1,'order_tracker','draft_customer_update','x','draft','draft')`, [NW.org]))
    const r = await setTier(actor, 'starter')
    expect(r.switchedOff).toEqual(['order_tracker'])
    const t = await teamView(actor)
    expect(t.agents.find(a => a.key === 'order_tracker')).toMatchObject({ enabled: false, locked: true })
    expect(t.agents.find(a => a.key === 'listing_writer')).toMatchObject({ enabled: true, locked: false })
    expect((await admin(db => db.one<{ status: string }>(`select status from library_actions where org_id = $1 and agent_key = 'order_tracker'`, [NW.org])))!.status).toBe('expired')
  })

  it('tier membership comes from the config, not from code: the view follows the JSON', async () => {
    const actor = await merchantActor(NW)
    const t = await teamView(actor)
    for (const a of t.agents) expect(a.locked).toBe(!LIBRARY.tiers.find(x => x.key === 'starter')!.agents.includes(a.key))
  })

  it('staff can read nothing of the team as a merchant and cannot switch agents; another store cannot see Northwind switches', async () => {
    const staff = await staffActor()
    await expect(teamView(staff)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(setSwitch(staff, 'listing_writer', true)).rejects.toMatchObject({ code: 'forbidden' })
    await resetLibrary(HB, 'starter')
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    await setSwitch(nw, 'listing_writer', true)
    expect((await teamView(hb)).agents.find(a => a.key === 'listing_writer')!.enabled).toBe(false)
  })
})
