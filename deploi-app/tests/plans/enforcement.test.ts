/**
 * Plan enforcement (lib/plans/allowance.ts, lib/plans/enforce.ts): what counts against the monthly action
 * allowance, the month boundary, holding at every choke point (store write, agent email, Office action,
 * library auto-run) while BILLING_MODE=test and nothing while it is off, Office seats and connections, and a
 * downgrade or lapse bringing the organization within its plan (deterministic, audited, nothing deleted,
 * nothing resumed by an upgrade). Organization isolation of usage.
 */
import '../library/helpers'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { NW, HB, merchantActor, resetMerchant, store } from '../merchant/helpers'
import { resetLibrary, actionsOf } from '../library/helpers'
import { setupOffice, resetOffice, grantedAgent, policyFor, actions as officeActions, lead, t0 } from '../office/helpers'
import { createAgent, grantPolicy, pauseAgent, resumeAgent, revokeAgent } from '../../lib/agents/lifecycle'
import { runAgent } from '../../lib/agents/run'
import { approveProposal } from '../../lib/engine/approve'
import { executeProposal } from '../../lib/engine/execute'
import { approveMessage } from '../../lib/email/engine'
import { startConnect, completeConnect } from '../../lib/email/accounts'
import { getSynthMail, syntheticCode, SYNTH_SEND } from '../../lib/email/adapters/synthetic'
import { runOfficeAgent } from '../../lib/office/run'
import { decideOfficeAction } from '../../lib/office/approvals'
import { executeOfficeAction } from '../../lib/office/actions'
import { createOfficeAgent, grantOfficePolicy, pauseOfficeAgent, resumeOfficeAgent } from '../../lib/office/agents'
import { connectSyntheticOffice } from '../../lib/office/connections'
import { setSwitch, setPermission, grantAutoRun } from '../../lib/library/switches'
import { runLibraryAgent, approveAction } from '../../lib/library/actions'
import { handleStripeEvent } from '../../lib/billing/webhooks'
import { billingWriteBlock } from '../../lib/billing/state'
import { PLAN_LIMITS } from '../../lib/plans/entitlements'
import { actionsUsed, allowanceBlock, planUsage, monthEnd } from '../../lib/plans/allowance'
import { enforcePlanLimits, enforceLapsedPlans } from '../../lib/plans/enforce'
import { controlRoom } from '../../lib/store/control-room'
import { DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'
import { NORTHWIND_IDS } from '../../lib/connectors/shopify/demo-store'
import type { Actor } from '../../lib/engine/actor'

const ready = await prepareDb()
const { P } = NORTHWIND_IDS
const UNTIL = new Date(Date.now() + 300 * 864e5).toISOString()
const STOCK = { correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: DEFAULT_EXEMPT_TAGS, flagInStockVariants: true } } }
const SAVED_LIMITS = JSON.parse(JSON.stringify(PLAN_LIMITS)) as typeof PLAN_LIMITS
const BILLING_ENV: Record<string, string> = {
  BILLING_MODE: 'test', STRIPE_PRICE_STARTER_MONTHLY: 'price_EnfStarter', STRIPE_PRICE_GROWTH_MONTHLY: 'price_EnfGrowth', STRIPE_PRICE_PRO_MONTHLY: 'price_EnfPro', BILLING_GRACE_DAYS: '7',
}
const savedEnv: Record<string, string | undefined> = {}
const billingOn = () => { for (const [k, v] of Object.entries(BILLING_ENV)) { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; process.env[k] = v } }
const billingOff = () => { for (const k of Object.keys(BILLING_ENV)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] } }
const setTierOf = (m: typeof NW, tier: string) => admin(db => db.query('update agencies set plan_tier = $2 where id = $1', [m.org, tier]))
const used = (m: typeof NW, now?: Date) => admin(db => actionsUsed(db, m.org, now))
const writes = async () => (await store(NW))!.writeLog.length
const variant = async (id: string) => (await store(NW))!.products.flatMap(p => p.variants).find(v => v.id === id)!

async function cleanOrg(m: typeof NW) {
  await admin(async db => {
    await db.query('delete from library_actions where org_id = $1', [m.org])
    await db.query('delete from billing_subscriptions where org_id = $1', [m.org])
    await db.query('delete from billing_customers where org_id = $1', [m.org])
  })
}

async function engineAgent(actor: Actor, name: string, policy: Record<string, unknown>) {
  const c = await createAgent(actor, { name, taskText: `${name} task`, policy: { connectionId: NW.conn, productScope: { mode: 'all' }, ...policy } })
  await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
  return c.agentId
}
const executionsOf = (agentId: string) => admin(db => db.query<{ id: string; status: string; status_reason: string | null; proposal_id: string }>(`select id, status, status_reason, proposal_id from executions where agent_id = $1 order by started_at, id`, [agentId]))
const proposal = (id: string) => admin(db => db.one<{ id: string; status: string; status_reason: string | null; change_hash: string; target_id: string }>('select id, status, status_reason, change_hash, target_id from proposals where id = $1', [id]))

const SENDER = 'agent@northwind-goods.example', OWNER = 'owner@northwind-goods.example', SUPPLIER = 'orders@supplier.example'
async function mailbox(actor: Actor) {
  const { url } = await startConnect(actor, { provider: 'synthetic' })
  const state = new URL(url, 'http://x').searchParams.get('state')!
  return (await completeConnect(actor, { state, code: syntheticCode(SENDER, [SYNTH_SEND]), error: null })).account
}
async function mailAgent(actor: Actor, accountId: string) {
  return engineAgent(actor, 'Restock Mailer', { approvalMode: 'review', email: {
    accountId, permission: 'send_autonomous', purpose: 'Ask our supplier to restock', tasks: ['supplier_reorder'], recipients: { addresses: [OWNER], domains: ['supplier.example'] }, notify: [OWNER],
    validUntil: new Date(Date.now() + 30 * 864e5).toISOString(), supplierReorder: { supplierAddress: SUPPLIER, thresholdAvailable: 0, cooldownDays: 7 } } })
}
const messagesOf = (agentId: string) => admin(db => db.query<{ id: string; status: string; status_reason: string | null; task_key: string; content_hash: string; approval_kind: string | null }>(
  'select id, status, status_reason, task_key, content_hash, approval_kind from email_messages where agent_id = $1 order by created_at', [agentId]))

/** the audit trail is append-only: each test reads only what it wrote */
let since = new Date().toISOString()
const HELD = /^held: this month's allowance of \d+ actions is used; it resets on \d{4}-\d{2}-01 or on upgrade$/

describe.skipIf(!ready)('plan enforcement', () => {
  beforeEach(async () => {
    since = new Date().toISOString()
    billingOff()
    Object.assign(PLAN_LIMITS.starter, SAVED_LIMITS.starter); Object.assign(PLAN_LIMITS.growth, SAVED_LIMITS.growth); Object.assign(PLAN_LIMITS.pro, SAVED_LIMITS.pro)
    await resetMerchant(NW, { ruleOn: false }); await resetMerchant(HB, { ruleOn: false })
    await cleanOrg(NW); await cleanOrg(HB)
    await setTierOf(NW, 'starter'); await setTierOf(HB, 'starter')
  })
  afterEach(() => { billingOff(); Object.assign(PLAN_LIMITS.starter, SAVED_LIMITS.starter); Object.assign(PLAN_LIMITS.growth, SAVED_LIMITS.growth); Object.assign(PLAN_LIMITS.pro, SAVED_LIMITS.pro) })
  afterAll(async () => {
    if (!ready) return
    await resetOffice(NW, { enable: false }); await resetLibrary(NW, 'starter'); await cleanOrg(NW)
    await resetMerchant(NW); await resetMerchant(HB)
  })

  it('counts carried-out store writes only: drafts, proposals, refused, blocked, stale and failed attempts never count', async () => {
    const actor = await merchantActor(NW)
    const review = await engineAgent(actor, 'Stock reviewer', { ...STOCK, approvalMode: 'review' })
    await runAgent(review, { trigger: 'test', actor: actor.label })
    expect(await used(NW)).toBe(0) // five proposals waiting: nothing carried out
    await revokeAgent(actor, review)
    const auto = await engineAgent(actor, 'Stock Guardian', { ...STOCK, approvalMode: 'autonomous', validUntil: UNTIL })
    await runAgent(auto, { trigger: 'test', actor: actor.label })
    const ex = await executionsOf(auto)
    expect(ex.map(e => e.status)).toEqual(Array(5).fill('verified'))
    expect(await used(NW)).toBe(5)
    for (const [status, counted] of [['executing', 5], ['applied', 5], ['unknown', 5], ['verified', 5], ['blocked', 0], ['stale', 0], ['failed', 0], ['verification_failed', 0], ['queued', 0], ['prechecking', 0]] as const) {
      await admin(db => db.query('update executions set status = $2 where agent_id = $1', [auto, status]))
      expect([status, await used(NW)]).toEqual([status, counted])
    }
  })

  it('the month is the UTC calendar month: an action at 23:59:59.999 on the last day belongs to that month; the count resets at 00:00 UTC on the 1st', async () => {
    const actor = await merchantActor(NW)
    const auto = await engineAgent(actor, 'Stock Guardian', { ...STOCK, approvalMode: 'autonomous', validUntil: UNTIL })
    await runAgent(auto, { trigger: 'test', actor: actor.label })
    await admin(db => db.query(`update executions set started_at = '2026-10-31T23:59:59.999Z' where agent_id = $1`, [auto]))
    expect(await used(NW, new Date('2026-10-01T00:00:00Z'))).toBe(5)
    expect(await used(NW, new Date('2026-10-31T23:59:59.999Z'))).toBe(5)
    expect(await used(NW, new Date('2026-11-01T00:00:00Z'))).toBe(0)
    await admin(db => db.query(`update executions set started_at = '2026-11-01T00:00:00Z' where agent_id = $1`, [auto]))
    expect(await used(NW, new Date('2026-10-31T23:59:59.999Z'))).toBe(0)
    expect(await used(NW, new Date('2026-11-30T23:59:59Z'))).toBe(5)
    expect(monthEnd(new Date('2026-12-15T10:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('store writes: at the allowance autonomous work is held for approval with the reason (not dropped); an individually approved item is held too; after an upgrade it can be approved and runs', async () => {
    billingOn()
    PLAN_LIMITS.starter.monthlyActions = 3
    const actor = await merchantActor(NW)
    const auto = await engineAgent(actor, 'Stock Guardian', { ...STOCK, approvalMode: 'autonomous', validUntil: UNTIL })
    const before = await writes()
    const r = await runAgent(auto, { trigger: 'test', actor: actor.label })
    expect(r.counts).toMatchObject({ autoApproved: 5, verified: 3 })
    expect(await writes()).toBe(before + 3)
    const ex = await executionsOf(auto)
    const held = ex.filter(e => e.status === 'blocked')
    expect(held).toHaveLength(2)
    const resetsOn = monthEnd(new Date()).toISOString().slice(0, 10)
    for (const e of held) {
      expect(e.status_reason).toMatch(HELD)
      expect(e.status_reason).toContain(`allowance of 3 actions is used; it resets on ${resetsOn} or on upgrade`)
      const p = (await proposal(e.proposal_id))!
      expect(p.status).toBe('pending_approval') // waiting again, not blocked or dropped
      expect(p.status_reason).toMatch(/^waiting for your approval: held: this month's allowance/)
      expect((await variant(p.target_id)).inventoryPolicy).toBe('CONTINUE')
    }
    const audits = await admin(db => db.query<{ detail: { cause: string } }>(`select detail from engine_audit where org_id = $1 and event = 'execution.held' and at >= $2`, [NW.org, since]))
    expect(audits).toHaveLength(2)
    expect(audits.every(a => a.detail.cause === 'allowance')).toBe(true)
    expect(await admin(db => allowanceBlock(db, NW.org))).toMatchObject({ used: 3, limit: 3 })

    // the merchant approves one by hand: still held, because the allowance is the paid unit
    const p1 = (await proposal(held[0].proposal_id))!
    await approveProposal(actor, p1.id, p1.change_hash)
    expect(await executeProposal(p1.id, { actor: actor.label })).toMatchObject({ status: 'blocked', reason: expect.stringMatching(HELD) })
    expect((await proposal(p1.id))!.status).toBe('pending_approval')
    expect(await writes()).toBe(before + 3)

    // upgrade: nothing runs by itself; approving it again carries it out
    await setTierOf(NW, 'growth')
    expect(await writes()).toBe(before + 3)
    await approveProposal(actor, p1.id, p1.change_hash)
    expect((await executeProposal(p1.id, { actor: actor.label })).status).toBe('verified')
    expect((await variant(p1.target_id)).inventoryPolicy).toBe('DENY')
  })

  it('with BILLING_MODE off (the free beta) the allowance is never enforced or queried', async () => {
    PLAN_LIMITS.starter.monthlyActions = 1
    const actor = await merchantActor(NW)
    const auto = await engineAgent(actor, 'Stock Guardian', { ...STOCK, approvalMode: 'autonomous', validUntil: UNTIL })
    const r = await runAgent(auto, { trigger: 'test', actor: actor.label })
    expect(r.counts).toMatchObject({ autoApproved: 5, verified: 5 })
    expect(await admin(db => allowanceBlock(db, NW.org))).toBeNull()
    expect(await admin(db => planUsage(db, NW.org))).toMatchObject({ actions: 5, actionsLimit: null, emailsLimit: null, enforced: false })
  })

  it('agent email: an accepted send counts; at the allowance the message waits for approval with the reason, nothing is sent; it can be approved after an upgrade', async () => {
    const actor = await merchantActor(NW)
    const acc = await mailbox(actor)
    const id = await mailAgent(actor, acc.id)
    billingOn()
    PLAN_LIMITS.starter.monthlyActions = 0
    await runAgent(id, { trigger: 'test', actor: actor.label })
    const [m] = (await messagesOf(id)).filter(x => x.task_key === 'supplier_reorder')
    expect(m).toMatchObject({ status: 'awaiting_approval', approval_kind: null })
    expect(m.status_reason).toMatch(HELD)
    expect((await getSynthMail(acc.id)).sent).toHaveLength(0)
    expect(await used(NW)).toBe(0)
    await setTierOf(NW, 'growth')
    expect((await approveMessage(actor, m.id, m.content_hash)).status).toBe('accepted')
    expect((await getSynthMail(acc.id)).sent).toHaveLength(1)
    expect(await used(NW)).toBe(1)
    // a sent message that later failed stops counting; an unsent one never counted
    for (const [status, n] of [['failed', 0], ['cancelled', 0], ['awaiting_approval', 0], ['delivery_unknown', 1], ['sending', 1], ['accepted', 1]] as const) {
      await admin(db => db.query('update email_messages set status = $2 where id = $1', [m.id, status]))
      expect([status, await used(NW)]).toEqual([status, n])
    }
    // a person's own reply is not an agent action
    await admin(db => db.query(`update email_messages set task_key = 'human_reply' where id = $1`, [m.id]))
    expect(await used(NW)).toBe(0)
  })

  it('email with billing off: sent at once, no allowance', async () => {
    PLAN_LIMITS.starter.monthlyActions = 0
    const actor = await merchantActor(NW)
    const acc = await mailbox(actor)
    const id = await mailAgent(actor, acc.id)
    await runAgent(id, { trigger: 'test', actor: actor.label })
    expect((await messagesOf(id)).find(x => x.task_key === 'supplier_reorder')!.status).toBe('accepted')
  })

  it('Office: at the allowance a covered action waits for approval with the reason and nothing goes out; a succeeded action counts once (not again as its email)', async () => {
    const T = t0()
    const s = await setupOffice(NW, [lead('801', 'ana@acme-studio.example', new Date(T.getTime() - 3600e3))])
    const agent = await grantedAgent(s, 'lead_followup', { email: 'send_autonomous' })
    billingOn()
    PLAN_LIMITS.starter.monthlyActions = 0
    await runOfficeAgent(agent, { trigger: 'test', now: T })
    let [a] = await officeActions(agent)
    expect(a).toMatchObject({ status: 'awaiting_approval', approval_kind: null, approved_hash: null })
    expect(a.status_reason).toMatch(HELD)
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(0)
    // after an upgrade the merchant approves it and it is carried out
    await setTierOf(NW, 'growth')
    await admin(db => decideOfficeAction(db, s.actor, a.id, 'approve', { shownHash: a.payload_hash }))
    expect((await executeOfficeAction(a.id, { now: T, actor: s.actor.label })).status).toBe('succeeded')
    expect((await getSynthMail(s.mailboxId)).sent).toHaveLength(1)
    expect(await used(NW, T)).toBe(1)
    ;[a] = await officeActions(agent)
    for (const [status, n] of [['failed', 0], ['cancelled', 0], ['unknown', 1], ['succeeded', 1]] as const) {
      await admin(db => db.query('update office_actions set status = $2 where id = $1', [a.id, status]))
      expect([status, await used(NW, T)]).toEqual([status, n])
    }
  })

  it('library auto-run: at the allowance writes are kept as drafts with the reason; approving one is refused until the allowance allows it', async () => {
    const NOW = new Date('2026-10-29T12:00:00Z')
    await resetLibrary(NW, 'starter')
    const actor = await merchantActor(NW)
    await setSwitch(actor, 'listing_writer', true)
    await setPermission(actor, 'listing_writer', 'act')
    await grantAutoRun(actor, 'listing_writer', 'draft_description', 5)
    billingOn()
    PLAN_LIMITS.starter.monthlyActions = 1
    const r = await runLibraryAgent({ orgId: NW.org, agentKey: 'listing_writer', trigger: 'test', actor: actor.label, now: NOW })
    expect(r.counts.done).toBe(1)
    const rows = await actionsOf(NW, 'listing_writer')
    const held = rows.filter(x => x.action_type === 'draft_description' && x.status === 'draft')
    expect(held.length).toBeGreaterThan(0)
    expect(held.every(x => /^act: held, this month's allowance of 1 actions is used/.test(x.permission_basis ?? ''))).toBe(true)
    expect(await used(NW, NOW)).toBe(1) // drafts do not count
    await expect(approveAction(actor, held[0].id, NOW)).rejects.toMatchObject({ code: 'allowance_exhausted' })
    expect((await actionsOf(NW, 'listing_writer')).find(x => x.id === held[0].id)!.status).toBe('draft')
    PLAN_LIMITS.starter.monthlyActions = 2
    expect(await approveAction(actor, held[0].id, NOW)).toMatchObject({ status: 'done' })
    expect(await used(NW, NOW)).toBe(2)
  })

  it('usage is per organization: one organization at its allowance does not hold another; the Control Room reports each one\'s own usage', async () => {
    billingOn()
    PLAN_LIMITS.starter.monthlyActions = 3
    const actor = await merchantActor(NW)
    const auto = await engineAgent(actor, 'Stock Guardian', { ...STOCK, approvalMode: 'autonomous', validUntil: UNTIL })
    await runAgent(auto, { trigger: 'test', actor: actor.label })
    expect(await used(NW)).toBe(3)
    expect(await used(HB)).toBe(0)
    expect(await admin(db => allowanceBlock(db, NW.org))).not.toBeNull()
    expect(await admin(db => allowanceBlock(db, HB.org))).toBeNull()
    const nw = await controlRoom(actor)
    expect(nw.usage).toMatchObject({ actions: 3, actionsLimit: 3, emailsLimit: PLAN_LIMITS.starter.monthlyEmails, enforced: true, resetsAt: monthEnd(new Date()).toISOString() })
    const hb = await controlRoom(await merchantActor(HB))
    expect(hb.usage).toMatchObject({ actions: 0, actionsLimit: 3 })
  })

  it('Office seats and connections are enforced at connect, create, grant and resume while billing is on (never in the beta)', async () => {
    await resetOffice(NW)
    const actor = await merchantActor(NW)
    billingOn()
    PLAN_LIMITS.starter.officeConnections = 1
    PLAN_LIMITS.starter.officeSeats = 1
    await connectSyntheticOffice(actor, 'hubspot', { demoData: false })
    await connectSyntheticOffice(actor, 'hubspot', { demoData: false }) // reconnecting the same account needs no new one
    await expect(connectSyntheticOffice(actor, 'google_calendar', { timezone: 'UTC' })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/allows 1 Office connections/) })
    billingOff()
    const s = await setupOffice(NW, []) // the beta: both connections and any number of agents
    billingOn()
    const a = await grantedAgent(s, 'lead_followup', {}, undefined, 'First')
    await expect(createOfficeAgent(s.actor, { kind: 'lead_followup', name: 'Second', policy: policyFor('lead_followup', s) })).rejects.toMatchObject({ message: expect.stringMatching(/allows 1 Office seats/) })
    await pauseOfficeAgent(s.actor, a)
    const b = await createOfficeAgent(s.actor, { kind: 'lead_followup', name: 'Second', policy: policyFor('lead_followup', s) })
    await grantOfficePolicy(s.actor, b.agentId, b.policyId, b.policyHash)
    await expect(resumeOfficeAgent(s.actor, a)).rejects.toMatchObject({ message: expect.stringMatching(/allows 1 Office seats/) })
    billingOff()
    await resumeOfficeAgent(s.actor, a)
    expect(await admin(db => db.one<{ n: string }>(`select count(*)::text as n from office_agents where org_id = $1 and status = 'active'`, [NW.org]))).toEqual({ n: '2' })
  })

  describe('downgrade and lapse', () => {
    let actor: Actor
    let agents: string[]
    let office: string[]
    let seq = 0
    const sub = async (type: string, price: string, status = 'active') => admin(db => handleStripeEvent(db, {
      id: `evt_enf_${process.pid}_${Date.now()}_${++seq}`, type, created: Math.floor(Date.now() / 1000) + seq, livemode: false,
      data: { object: { id: 'sub_Enf1', object: 'subscription', customer: 'cus_Enf1', status, cancel_at_period_end: false, metadata: {}, items: { data: [{ price: { id: price }, current_period_end: 1_900_000_000 }] } } },
    }))
    const statusOf = (ids: string[], table = 'agents') => admin(db => db.query<{ id: string; status: string }>(`select id, status from ${table} where id = any($1::uuid[])`, [ids])).then(r => ids.map(id => r.find(x => x.id === id)!.status))
    const switchOn = () => admin(db => db.query<{ agent_key: string; enabled: boolean; engine_agent_id: string | null }>('select agent_key, enabled, engine_agent_id from library_switches where org_id = $1 order by agent_key', [NW.org]))

    beforeEach(async () => {
      // the beta: a pro team with three engine agents, two library agents and two Office agents
      await resetLibrary(NW, 'pro'); await cleanOrg(NW)
      actor = await merchantActor(NW)
      agents = []
      for (const [i, n] of ['Oldest', 'Middle', 'Newest'].entries()) { agents.push(await engineAgent(actor, n, { ...STOCK, approvalMode: 'review', productScope: { mode: 'products', productIds: [P(1001 + i)] } })); await new Promise(r => setTimeout(r, 5)) }
      await setSwitch(actor, 'supplier_chaser', true, { settings: { supplierAddress: SUPPLIER } }) // growth and up, engine-backed
      await setSwitch(actor, 'listing_writer', true) // every tier
      const s = await setupOffice(NW, [])
      office = [await grantedAgent(s, 'lead_followup', {}, undefined, 'Office A')]
      await new Promise(r => setTimeout(r, 5))
      office.push(await grantedAgent(s, 'lead_followup', {}, undefined, 'Office B'))
      // billed by Stripe from here on (no active Shopify store), with a known customer
      await admin(async db => {
        await db.query(`update store_connections set status = 'uninstalled' where id = $1`, [NW.conn])
        await db.query(`insert into billing_customers (org_id, external_id) values ($1, 'cus_Enf1')`, [NW.org])
      })
      billingOn()
      PLAN_LIMITS.starter.maxAgents = 2
      PLAN_LIMITS.starter.officeSeats = 1
    })

    it('a Stripe downgrade switches off library agents the tier excludes and pauses the newest agents beyond the plan, audited, nothing deleted; repeating changes nothing; an upgrade resumes nothing', async () => {
      await sub('customer.subscription.updated', 'price_EnfPro')
      expect(await statusOf(agents)).toEqual(['active', 'active', 'active'])
      const r = await sub('customer.subscription.updated', 'price_EnfStarter')
      expect(r).toMatchObject({ outcome: 'processed', detail: 'subscription active; plan limits applied' })
      const sw = await switchOn()
      expect(sw.find(x => x.agent_key === 'supplier_chaser')!.enabled).toBe(false)
      expect(sw.find(x => x.agent_key === 'listing_writer')!.enabled).toBe(true)
      const chaserEngine = sw.find(x => x.agent_key === 'supplier_chaser')!.engine_agent_id!
      expect(await statusOf([chaserEngine])).toEqual(['paused'])
      // the oldest two keep running; the most recently created is paused
      expect(await statusOf(agents)).toEqual(['active', 'active', 'paused'])
      expect(await statusOf(office, 'office_agents')).toEqual(['active', 'paused'])
      const paused = await admin(db => db.one<{ detail: { reason: string } }>(`select detail from engine_audit where org_id = $1 and entity_id = $2 and event = 'agent.paused' and at >= $3 order by at desc limit 1`, [NW.org, agents[2], since]))
      expect(paused!.detail.reason).toMatch(/allows 2 active agents and this is one of the most recently created/)
      const enforced = await admin(db => db.query<{ detail: Record<string, unknown> }>(`select detail from engine_audit where org_id = $1 and event = 'plan.enforced' and at >= $2`, [NW.org, since]))
      expect(enforced).toHaveLength(1)
      expect(enforced[0].detail).toMatchObject({ tier: 'starter', lapsed: false, library_switched_off: ['supplier_chaser'], agents_paused: [agents[2]], office_agents_paused: [office[1]] })
      // nothing deleted: the agents, switches and Office agents are all still there
      expect(await admin(db => db.one<{ n: string }>(`select count(*)::text as n from agents where org_id = $1 and status <> 'deleted'`, [NW.org]))).toEqual({ n: '4' })
      expect(await statusOf(office, 'office_agents')).toHaveLength(2)
      // deterministic and idempotent
      expect(await admin(db => enforcePlanLimits(db, NW.org, { actor: 'test', cause: 'again' }))).toMatchObject({ changed: false })
      // the merchant cannot resume past the plan
      await expect(resumeAgent(actor, agents[2])).rejects.toMatchObject({ message: expect.stringMatching(/allows 2 active agents/) })
      // an upgrade resumes nothing and switches nothing back on
      await sub('customer.subscription.updated', 'price_EnfPro')
      expect(await statusOf(agents)).toEqual(['active', 'active', 'paused'])
      expect(await statusOf(office, 'office_agents')).toEqual(['active', 'paused'])
      expect((await switchOn()).find(x => x.agent_key === 'supplier_chaser')!.enabled).toBe(false)
      // within the new limits the merchant resumes it themselves
      await resumeAgent(actor, agents[2])
      expect(await statusOf(agents)).toEqual(['active', 'active', 'active'])
    })

    it('a cancelled subscription is a lapse: the lowest tier\'s limits apply and the account is read-only; nothing is deleted', async () => {
      await sub('customer.subscription.updated', 'price_EnfPro')
      await sub('customer.subscription.deleted', 'price_EnfPro', 'canceled')
      expect(await statusOf(agents)).toEqual(['active', 'active', 'paused'])
      expect((await switchOn()).find(x => x.agent_key === 'supplier_chaser')!.enabled).toBe(false)
      expect(await admin(db => billingWriteBlock(db, NW.org))).toMatch(/^read-only: the subscription was cancelled/)
      const e = await admin(db => db.one<{ detail: Record<string, unknown> }>(`select detail from engine_audit where org_id = $1 and event = 'plan.enforced' and at >= $2`, [NW.org, since]))
      expect(e!.detail).toMatchObject({ tier: 'starter', lapsed: true, cause: 'customer.subscription.deleted' })
      // a library agent the lapsed plan excludes cannot be switched back on
      await expect(setSwitch(actor, 'supplier_chaser', true)).rejects.toMatchObject({ code: 'upgrade_required' })
    })

    it('past due beyond the grace period lapses by time alone: the hourly sweep applies the lower limits; within grace nothing changes', async () => {
      await sub('customer.subscription.updated', 'price_EnfPro')
      await admin(db => db.query(`update billing_subscriptions set status = 'past_due', past_due_since = now() - interval '3 days' where org_id = $1`, [NW.org]))
      expect(await enforceLapsedPlans()).toEqual([])
      expect(await statusOf(agents)).toEqual(['active', 'active', 'active'])
      await admin(db => db.query(`update billing_subscriptions set past_due_since = now() - interval '8 days' where org_id = $1`, [NW.org]))
      const r = await enforceLapsedPlans()
      expect(r.map(x => x.lapsed)).toEqual([true])
      expect(await statusOf(agents)).toEqual(['active', 'active', 'paused'])
      expect(await statusOf(office, 'office_agents')).toEqual(['active', 'paused'])
      expect(await enforceLapsedPlans()).toEqual([]) // nothing more to do
    })

    it('with billing off enforcement does nothing', async () => {
      billingOff()
      expect(await admin(db => enforcePlanLimits(db, NW.org, { actor: 'test', cause: 'test' }))).toBeNull()
      expect(await statusOf(agents)).toEqual(['active', 'active', 'active'])
      expect(await pauseAgent(actor, agents[0])).toBeTruthy()
    })
  })
})
