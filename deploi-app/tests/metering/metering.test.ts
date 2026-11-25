/**
 * Pricing v2: action metering (lib/metering), the overage cap pause, server-side plan gating through the API,
 * and the pricing catalog the site, the app and the listing share.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { admin } from '../../lib/db'
import { encodeDevSession, DEV_COOKIE_NAME } from '../../lib/auth'
import { setNotifyImpl, type OwnerUpdate } from '../../lib/notify'
import { recordAction, usageState, setOverageCap, capCheck, isBillableType } from '../../lib/metering'
import { CATALOG, STORE_PLANS, OFFICE_PLANS, priceCents, officePriceCents, setupFeeCents, storePlanFor, officeAgentsFor, overageCents, unitsForCap, yearlyCents } from '../../lib/pricing'
import { LIBRARY } from '../../lib/library/config'
import { resetLibrary } from '../library/helpers'
import { NW } from '../merchant/helpers'

let cookieValue: string | undefined
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === DEV_COOKIE_NAME && cookieValue ? { value: cookieValue } : undefined), set: () => {}, delete: () => {}, getAll: () => [] }),
  headers: async () => new Headers(),
}))

const ready = await prepareDb()
process.env.ALLOW_DEV_LOGIN = 'true'
const told: OwnerUpdate[] = []
setNotifyImpl({ owner: async u => { told.push(u); return { status: 'sent', id: u.dedupeKey } } })
const NOW = new Date('2026-11-20T12:00:00Z')

async function reset(plan: string | null, tier = 'starter') {
  await admin(async db => {
    for (const t of ['actions', 'org_usage_caps', 'usage_cap_events']) await db.query(`delete from ${t} where org_id = $1`, [NW.org])
    await db.query('update agencies set plan_key = $2, plan_tier = $3 where id = $1', [NW.org, plan, tier])
  })
  told.length = 0
}
const fill = (n: number, kind: 'action' | 'text' = 'action') => admin(db => db.query(
  `insert into actions (org_id, agent_key, type, kind, billable, dedupe_key, created_at) select $1, 'test', $2, $3, true, 'fill:' || $3 || ':' || g, $4 from generate_series(1, $5) g`,
  [NW.org, kind === 'text' ? 'send_text' : 'update_listing', kind, NOW.toISOString(), n]))

describe('pricing catalog (the one source for the site, the app and the listing)', () => {
  it('Store: Starter $79 / 1,500, Growth $199 / 5,000, Pro $499 / 15,000; 14-day trial; yearly = 2 months free; $5 per 100 actions', () => {
    expect(STORE_PLANS.map(p => [p.key, p.monthlyCents, p.actions, p.customAgents])).toEqual([['starter', 7900, 1500, 1], ['growth', 19900, 5000, 5], ['pro', 49900, 15000, null]])
    expect(CATALOG.store.trialDays).toBe(14)
    expect(priceCents('starter', 'year')).toBe(79000)
    expect(yearlyCents(19900)).toBe(199000)
    expect(CATALOG.store.overage).toMatchObject({ unitActions: 100, priceCents: 500 })
    expect(CATALOG.store.billedVia).toBe('shopify')
  })
  it('Office: Solo $149, Team $349, Business $799 with actions + texts; $499 setup on Solo/Team; 20% off with Store; Stripe', () => {
    expect(OFFICE_PLANS.map(p => [p.key, p.monthlyCents, p.actions, p.texts, p.crew, p.customAgents])).toEqual([['solo', 14900, 2000, 300, 0, 1], ['team', 34900, 6000, 1000, 15, 5], ['business', 79900, 20000, 4000, null, null]])
    expect([setupFeeCents('solo'), setupFeeCents('team'), setupFeeCents('business')]).toEqual([49900, 49900, 0])
    expect(officePriceCents('team', 'month', true)).toBe(27920)
    expect(officePriceCents('team', 'month', false)).toBe(34900)
    expect(CATALOG.office.billedVia).toBe('stripe')
    expect(officeAgentsFor('solo')).toEqual(['lead_responder', 'invoice_runner', 'crm_followup', 'owner_updates'])
    expect(officeAgentsFor('team')).toEqual(expect.arrayContaining(['dispatch_coordinator', 'books_reconciler']))
  })
  it('the library tiers equal the catalog (agents, actions, price), and every agent unlocks at the expected plan', () => {
    for (const t of LIBRARY.tiers) {
      const p = STORE_PLANS.find(x => x.key === t.key)!
      expect([t.agents.slice().sort(), t.monthlyActions, t.proposedPriceUsd * 100]).toEqual([p.agents.slice().sort(), p.actions, p.monthlyCents])
    }
    expect(['order_tracker', 'inventory_watcher', 'listing_writer', 'supplier_chaser', 'customer_care', 'weekly_insights', 'store_health_checker'].map(storePlanFor)).toEqual(Array(7).fill('starter'))
    expect(['returns', 'campaign', 'promo_manager', 'payout_fees_checker'].map(storePlanFor)).toEqual(Array(4).fill('growth'))
    expect(storePlanFor('ai_visibility')).toBe('pro')
  })
  it('overage math: whole blocks of 100; a cap pays for whole blocks only', () => {
    expect(overageCents(1, 100, 500)).toBe(500)
    expect(overageCents(250, 100, 500)).toBe(1500)
    expect(unitsForCap(2499, 100, 500)).toBe(400)
  })
})

describe.skipIf(!ready)('action metering', () => {
  beforeEach(() => reset(null))
  afterAll(async () => { await reset(null); delete process.env.BILLING_MODE })

  it('billable: a step that changes something outside Deploi; free: watching, scanning, checking', () => {
    for (const t of ['send_customer_email', 'send_text', 'update_listing', 'invoice_send', 'book_appointment', 'update_crm', 'reorder', 'draft_supplier_followup']) expect(isBillableType(t), t).toBe(true)
    for (const t of ['scan_store', 'check_inventory', 'watch_competitor', 'flag_late_order', 'reconcile_payout', 'recommend_visibility_fix', 'detect_oversell']) expect(isBillableType(t), t).toBe(false)
  })

  it('the ledger records each completed step once, with its proof pointer and billable flag', async () => {
    const a = await admin(db => recordAction(db, { orgId: NW.org, agentKey: 'inventory_watcher', type: 'update_listing', proofRef: 'DC-000123', dedupeKey: 'loop:1' }))
    const again = await admin(db => recordAction(db, { orgId: NW.org, agentKey: 'inventory_watcher', type: 'update_listing', proofRef: 'DC-000123', dedupeKey: 'loop:1' }))
    const free = await admin(db => recordAction(db, { orgId: NW.org, agentKey: 'store_health_checker', type: 'check_inventory', proofRef: 'DC-000124', dedupeKey: 'loop:2' }))
    expect([a.billable, again.duplicate, again.id === a.id, free.billable]).toEqual([true, true, true, false])
    const rows = await admin(db => db.query<{ agent_key: string; type: string; billable: boolean; proof_ref: string }>('select agent_key, type, billable, proof_ref from actions where org_id = $1 order by created_at', [NW.org]))
    expect(rows).toEqual([{ agent_key: 'inventory_watcher', type: 'update_listing', billable: true, proof_ref: 'DC-000123' }, { agent_key: 'store_health_checker', type: 'check_inventory', billable: false, proof_ref: 'DC-000124' }])
    expect((await admin(db => usageState(db, NW.org))).actions).toMatchObject({ used: 1, included: 1500 })
  })

  it('at the cap non-urgent work pauses and the owner is told once; urgent work still goes; raising the cap resumes; billing off never holds', async () => {
    process.env.BILLING_MODE = 'test'
    await fill(1500)
    expect((await admin(db => usageState(db, NW.org, NOW))).actions).toMatchObject({ used: 1500, cap: 1500, atCap: true, overage: 0 })
    const held = await admin(db => capCheck(db, NW.org, 'update_listing', NOW))
    expect(held).toMatchObject({ allowed: false, used: 1500, cap: 1500 })
    await admin(db => capCheck(db, NW.org, 'invoice_send', NOW))
    expect(told.filter(u => /actions for this month are used up/.test(u.headline))).toHaveLength(1)
    expect(await admin(db => capCheck(db, NW.org, 'send_customer_email', NOW))).toEqual({ allowed: true }) // a customer is waiting
    expect(await admin(db => capCheck(db, NW.org, 'check_inventory', NOW))).toEqual({ allowed: true }) // free
    // the merchant allows $25 of overage: 500 more actions
    await admin(db => setOverageCap(db, NW.org, { actionCapCents: 2500, by: 'owner' }))
    expect((await admin(db => usageState(db, NW.org, NOW))).actions).toMatchObject({ cap: 2000, atCap: false })
    expect(await admin(db => capCheck(db, NW.org, 'update_listing', NOW))).toEqual({ allowed: true })
    await fill(0)
    await admin(db => db.query(`insert into actions (org_id, agent_key, type, billable, dedupe_key, created_at) select $1, 't', 'update_listing', true, 'more:' || g, $2 from generate_series(1, 500) g`, [NW.org, NOW.toISOString()]))
    expect((await admin(db => usageState(db, NW.org, NOW))).actions).toMatchObject({ used: 2000, overage: 500, atCap: true })
    expect((await admin(db => capCheck(db, NW.org, 'update_listing', NOW))).allowed).toBe(false)
    process.env.BILLING_MODE = 'off'
    expect(await admin(db => capCheck(db, NW.org, 'update_listing', NOW))).toEqual({ allowed: true })
  })

  it('Office plans meter texts separately: Solo allows 300 texts; at the text cap non-urgent texts wait', async () => {
    process.env.BILLING_MODE = 'test'
    await reset('solo')
    await fill(300, 'text')
    const s = await admin(db => usageState(db, NW.org, NOW))
    expect(s.plan).toBe('solo')
    expect(s.texts).toMatchObject({ used: 300, included: 300, atCap: true })
    expect(s.actions).toMatchObject({ used: 0, included: 2000 })
    expect((await admin(db => capCheck(db, NW.org, 'notify_crew', NOW, 'text'))).allowed).toBe(false)
    expect((await admin(db => capCheck(db, NW.org, 'send_text', NOW, 'text'))).allowed).toBe(true) // urgent: a caller is waiting
    await reset(null)
  })
})

describe.skipIf(!ready)('plan gating is enforced on the server (API), not just in the UI', () => {
  beforeEach(async () => { await reset(null); await resetLibrary(NW, 'starter') })
  const route = () => import('../../app/api/store/library/[key]/[action]/route')
  const post = async (key: string, action: string, body: unknown) => {
    cookieValue = encodeDevSession(SESSIONS.northwind)
    const { POST } = await route()
    const res = await POST(new Request(`http://localhost:3000/api/store/library/${key}/${action}`, { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ key, action }) })
    return { status: res.status, json: await res.json() as { ok?: boolean; error?: string; enabled?: boolean } }
  }
  it('Starter: a Growth agent and the Pro agent cannot be switched on through the API (402); a Starter agent can', async () => {
    expect(await post('returns', 'switch', { enabled: true })).toMatchObject({ status: 402, json: { error: 'upgrade_required' } })
    expect(await post('ai_visibility', 'switch', { enabled: true })).toMatchObject({ status: 402, json: { error: 'upgrade_required' } })
    expect(await post('returns', 'permission', { level: 'act' })).toMatchObject({ status: 402 })
    expect(await post('order_tracker', 'switch', { enabled: true })).toMatchObject({ status: 200, json: { ok: true, enabled: true } })
  })
  it('Growth: Returns switches on; AI Visibility (Pro) is still refused', async () => {
    await resetLibrary(NW, 'growth')
    expect(await post('returns', 'switch', { enabled: true })).toMatchObject({ status: 200, json: { enabled: true } })
    expect(await post('ai_visibility', 'switch', { enabled: true })).toMatchObject({ status: 402 })
  })
})
