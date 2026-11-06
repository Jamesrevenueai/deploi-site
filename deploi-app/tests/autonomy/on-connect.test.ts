/**
 * Autonomy on connect (lib/autonomy/on-connect.ts, lib/autonomy/pacing.ts): a connection alone, with no other click
 * and no other trigger, turns the packs on, sets the Office team up at the owner's autonomy settings, runs the first
 * check inside the same job run, paces customer messages in the first day, and tells the owner once.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { runDueJobs } from '../../lib/jobs'
import { setNotifyImpl, type OwnerUpdate } from '../../lib/notify'
import { onConnected, ON_CONNECT_ACTOR, AUTONOMY_POLICY_VERSION, foundSummary } from '../../lib/autonomy/on-connect'
import { takeOutboundSlot } from '../../lib/autonomy/pacing'
import { runAgentLoop } from '../../lib/events/loop'
import { currentEvent } from '../../lib/events'
import { setMode } from '../../lib/autonomy/settings'
import { chooseBusinessType, orgPacks, updatePackConfig, inferFromConnections } from '../../lib/packs/settings'
import { packsOverview } from '../../lib/packs/dashboard'
import { emitSweep } from '../../lib/events'
import { connectSyntheticOffice } from '../../lib/office/connections'
import { connectSyntheticMailbox } from '../../lib/office/mailbox'
import { revokeOfficeAgent } from '../../lib/office/agents'
import { executeDue } from '../../lib/office/run'
import { mutateQboSynth, synthInvoice } from '../../lib/office/quickbooks-synthetic'
import { getSynthMail } from '../../lib/email/adapters/synthetic'
import { ensureInstalled } from '../../lib/connectors/shopify/install'
import { resetCommerce } from '../commerce/pack-helpers'
import { resetOffice } from '../office/helpers'
import { NW, HB, merchantActor } from '../merchant/helpers'
import '../../lib/packs'

const ready = await prepareDb()
const T = new Date()
/** A time zone where it is early afternoon now, so the templates' quiet hours (19:00-08:00) never hold a send. */
function afternoonZone(): string {
  let off = 13 - new Date().getUTCHours()
  if (off > 12) off -= 24
  if (off < -12) off += 24
  return off === 0 ? 'UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`
}
const day = (n: number) => new Date(T.getTime() + n * 864e5).toISOString().slice(0, 10)
const overdue = (i: number) => synthInvoice(String(2000 + i), { docNumber: String(2000 + i), totalAmt: 100 + i, dueDate: day(-21), txnDate: day(-21), customerId: String(300 + i), customerName: `Customer ${i}`, billEmail: `ap${i}@customer-${i}.example` })

const updates: OwnerUpdate[] = []
function capture() { setNotifyImpl({ owner: async u => { if (!updates.some(x => x.dedupeKey === u.dedupeKey)) updates.push(u); return { status: 'sent', id: u.dedupeKey } } }) }

async function clean(m: typeof NW) {
  await admin(async db => {
    await db.query(`delete from jobs where status in ('queued','running') or (org_id = $1 and kind like 'autonomy.%')`, [m.org])
    for (const t of ['autonomy_backlog', 'autonomy_outbound', 'autonomy_connects', 'agent_loops', 'agent_events', 'org_action_modes', 'pack_activity', 'pack_settings', 'discovery_agents', 'discovery_runs', 'business_profiles', 'owner_updates'])
      await db.query(`delete from ${t} where org_id = $1`, [m.org])
    await db.query(`delete from cases where org_id = $1`, [m.org])
  })
  await resetOffice(m)
  updates.length = 0
}
const drain = () => runDueJobs({ limit: 400, deadlineMs: 120_000 })
const one = <T,>(sql: string, p: unknown[] = []) => admin(db => db.one<T>(sql, p))
const rows = <T,>(sql: string, p: unknown[] = []) => admin(db => db.query<T>(sql, p))
const officeAgents = (m: typeof NW) => rows<{ id: string; kind: string; status: string; created_by: string }>(`select id, kind, status, created_by from office_agents where org_id = $1 order by created_at`, [m.org])
const grantOf = (agentId: string) => one<{ granted_by: string; policy: { email: { tier: string; validUntil: string | null } } }>(`select p.granted_by, p.policy from office_agents a join office_agent_policies p on p.id = a.active_policy_id where a.id = $1`, [agentId])

afterAll(async () => { if (ready) { await admin(db => db.query(`update agencies set timezone = 'UTC' where id = $1`, [NW.org])); await clean(NW); await clean(HB); await resetOffice(NW, { enable: false }); await resetOffice(HB, { enable: false }) } })

describe.skipIf(!ready)('packs turn on by themselves when a system is connected', () => {
  beforeEach(async () => { capture(); await clean(NW) })

  it('connecting QuickBooks infers the office packs (source inferred); a later store refines it; an owner choice is never overridden', async () => {
    const actor = await merchantActor(NW)
    await connectSyntheticOffice(actor, 'quickbooks', { demoData: false })
    let p = await admin(db => orgPacks(db, NW.org))
    expect([p.businessType, p.source, p.packs]).toEqual(['office', 'inferred', ['office']])
    // a store connected later is more specific than the generic inference
    expect(await onConnected({ orgId: NW.org, kind: 'shopify', connectionId: NW.conn })).toMatchObject({ status: 'queued', businessType: 'store', inferred: true })
    p = await admin(db => orgPacks(db, NW.org))
    expect([p.businessType, p.source, p.packs.sort()]).toEqual(['store', 'inferred', ['commerce', 'office']])
    // the owner chooses: from now on no connection changes it
    await chooseBusinessType(actor, { businessType: 'home_services', trade: 'cleaning' })
    await connectSyntheticMailbox(actor, 'office@northwind-office.example')
    expect(await onConnected({ orgId: NW.org, kind: 'buildium', connectionId: '00000000-0000-4000-8000-00000000b001' })).toMatchObject({ businessType: 'home_services', inferred: false })
    p = await admin(db => orgPacks(db, NW.org))
    expect([p.businessType, p.source]).toEqual(['home_services', 'owner'])
  })

  it('Buildium infers property management; a Shopify install records the connect and infers a store', async () => {
    expect(await onConnected({ orgId: NW.org, kind: 'buildium', connectionId: '00000000-0000-4000-8000-00000000b002' })).toMatchObject({ businessType: 'property_manager', inferred: true })
    expect((await admin(db => orgPacks(db, NW.org))).packs.sort()).toEqual(['leasing', 'office', 'property_management'])
    // a real (non-synthetic) install through ensureInstalled: a new shop, a new organization, packs inferred at install
    const shop = `autonomy-${Date.now().toString(36)}.myshopify.com`
    const r = await ensureInstalled(shop, 'id-token', { exchange: async () => ({ accessToken: 'shpat_test', scope: ['read_products', 'write_products', 'read_inventory', 'read_locations'], expiresIn: null, refreshToken: null, refreshTokenExpiresIn: null }), info: async () => ({ name: 'Autonomy Shop', timezone: 'UTC', currency: 'USD', isDevelopmentStore: true, planName: 'partner_test' }) })
    try {
      expect(await one(`select kind, status from autonomy_connects where org_id = $1 and connection_id = $2`, [r.orgId, r.connectionId])).toEqual({ kind: 'shopify', status: 'queued' })
      expect(await one(`select business_type, source from pack_settings where org_id = $1`, [r.orgId])).toEqual({ business_type: 'store', source: 'inferred' })
      expect(await one(`select kind from jobs where org_id = $1 and idempotency_key = $2`, [r.orgId, `connect:${r.connectionId}`])).toEqual({ kind: 'autonomy.connect' })
    } finally {
      await admin(async db => { await db.query(`delete from jobs where org_id = $1`, [r.orgId]); await db.query(`update store_connections set status = 'uninstalled' where id = $1`, [r.connectionId]) })
    }
  })
})

describe.skipIf(!ready)('the first check runs at connect, inside one job run, with no other trigger', () => {
  beforeEach(async () => { capture(); await clean(NW) })

  it('a store connect -> agent_loops rows and fixes from one runDueJobs; the sweep is the connect sweep; the owner gets one summary', async () => {
    await resetCommerce(NW, ['weak_description', 'selling_past_zero'])
    await admin(db => db.query(`delete from agent_events where org_id = $1`, [NW.org]))
    capture()
    const t = new Date()
    expect((await onConnected({ orgId: NW.org, kind: 'shopify', connectionId: NW.conn })).status).toBe('queued')
    await drain()
    const loops = await rows<{ agent_key: string; action_type: string; state: string }>(`select agent_key, action_type, state from agent_loops where org_id = $1 and created_at >= $2`, [NW.org, t])
    expect(loops.length).toBeGreaterThan(0)
    expect(loops.some(l => l.state === 'done')).toBe(true)
    // the only trigger was the connect: one sweep event, connect:<connection id>
    expect(await rows(`select source, external_id from agent_events where org_id = $1`, [NW.org])).toEqual([{ source: 'sweep', external_id: `connect:${NW.conn}` }])
    // internal fixes (store data) are not paced
    expect(await rows(`select 1 from autonomy_backlog where org_id = $1 and action_type in ('update_listing','update_inventory_policy')`, [NW.org])).toEqual([])
    const s = updates.filter(u => u.dedupeKey === `autonomy:found:${NW.conn}`)
    expect(s).toHaveLength(1)
    expect(s[0].headline).toBe("Here's what I found in your Shopify store")
    expect(s[0].proof.find(p => p.label === 'Pause everything')?.url).toMatch(/\/store\?pause=all$/)
    const sum = await admin(db => foundSummary(db, NW.org))
    expect(sum.found).toBeGreaterThan(0)
    expect(sum.fixed).toBeGreaterThan(0)
  })
})

describe.skipIf(!ready)('the Office team is set up without clicks, at the owner\'s autonomy settings', () => {
  beforeEach(async () => { capture(); await clean(NW); await admin(db => db.query(`update agencies set timezone = $2 where id = $1`, [NW.org, afternoonZone()])) })

  async function connectQuickBooks(n: number) {
    const actor = await merchantActor(NW)
    const qb = await connectSyntheticOffice(actor, 'quickbooks', { demoData: false })
    await mutateQboSynth(qb.id, s => { s.invoices = Array.from({ length: n }, (_, i) => overdue(i)) })
    const mb = await connectSyntheticMailbox(actor, 'ar@northwind-office.example')
    return { actor, qb, mb }
  }

  it('do-it-and-tell-me -> Accounts Receivable granted to act, by autonomy:on-connect with the policy version; the first check sends', async () => {
    const { qb, mb } = await connectQuickBooks(2)
    await drain()
    const agents = await officeAgents(NW)
    expect(agents.map(a => [a.kind, a.status, a.created_by])).toEqual([['accounts_receivable', 'active', ON_CONNECT_ACTOR]])
    const g = (await grantOf(agents[0].id))!
    expect(g.granted_by).toBe(ON_CONNECT_ACTOR)
    expect(g.policy.email.tier).toBe('send_autonomous')
    expect(new Date(g.policy.email.validUntil!).getTime()).toBeGreaterThan(T.getTime() + 300 * 864e5)
    const audit = await one<{ actor: string; detail: { basis: { policy_version: string; modes: { email: Record<string, string> } } } }>(`select actor, detail from engine_audit where entity_type = 'office_policy' and event = 'office.policy.granted' and org_id = $1 and entity_id = (select active_policy_id::text from office_agents where id = $2)`, [NW.org, agents[0].id])
    expect(audit!.actor).toBe(ON_CONNECT_ACTOR)
    expect(audit!.detail.basis.policy_version).toBe(AUTONOMY_POLICY_VERSION)
    expect(audit!.detail.basis.modes.email).toEqual({ send_customer_email: 'act_and_tell', send_reminder: 'act_and_tell' })
    // the connect sweep ran it at once: both reminders went out
    expect((await getSynthMail(mb.id)).sent.map(m => [m.to].flat()[0]).sort()).toEqual(['ap0@customer-0.example', 'ap1@customer-1.example'])
    expect(updates.filter(u => u.dedupeKey === `autonomy:found:${qb.id}`)).toHaveLength(1)
  })

  it('ask-first stays ask-first: the email tool is granted "after my approval" and nothing is sent', async () => {
    await setMode(await merchantActor(NW), 'send_customer_email', 'ask_first')
    const { mb } = await connectQuickBooks(2)
    await drain()
    const [a] = await officeAgents(NW)
    expect((await grantOf(a.id))!.policy.email).toMatchObject({ tier: 'send_approved', validUntil: null })
    expect((await getSynthMail(mb.id)).sent).toEqual([])
    // the work waits for the owner (the approvals inbox), exactly as an ask-first action does without autonomy
    expect((await rows<{ status: string }>(`select status from pack_activity where org_id = $1 and agent_key = 'office_overdue_invoices'`, [NW.org])).map(x => x.status)).toContain('waiting_for_owner')
    expect((await rows(`select 1 from office_actions where agent_id = $1 and status in ('succeeded','executing')`, [a.id]))).toEqual([])
  })

  it('duplicate connect events do not duplicate agents, sweeps or the summary; an agent the owner deleted is never re-created', async () => {
    const { actor, qb } = await connectQuickBooks(1)
    // the same connection again (a repeated callback, a reconnect of the same account)
    await connectSyntheticOffice(actor, 'quickbooks', { demoData: false })
    expect((await onConnected({ orgId: NW.org, kind: 'office', connectionId: qb.id, provider: 'quickbooks' })).status).toBe('duplicate')
    await drain(); await drain()
    expect((await officeAgents(NW)).length).toBe(1)
    expect((await rows(`select 1 from autonomy_connects where org_id = $1 and connection_id = $2`, [NW.org, qb.id])).length).toBe(1)
    expect((await rows(`select 1 from agent_events where org_id = $1 and external_id = $2`, [NW.org, `connect:${qb.id}`])).length).toBe(1)
    expect(updates.filter(u => u.dedupeKey === `autonomy:found:${qb.id}`)).toHaveLength(1)
    // the owner deletes the agent; a new connection does not bring it back
    const [a] = await officeAgents(NW)
    await revokeOfficeAgent(actor, a.id, { delete: true })
    await connectSyntheticOffice(actor, 'hubspot', { demoData: false })
    await drain()
    expect((await officeAgents(NW)).map(x => x.status)).toEqual(['deleted'])
    const hub = await one<{ result: { team?: { template: string; status: string }[]; teamSkipped?: string } }>(`select result from autonomy_connects where org_id = $1 and kind = 'office' and provider = 'hubspot'`, [NW.org])
    expect(hub!.result.team?.find(t => t.template === 'accounts_receivable')?.status ?? 'not recommended').not.toBe('created')
  })
})

describe.skipIf(!ready)('first-day pacing of customer messages (the backlog guard)', () => {
  beforeEach(async () => { capture(); await clean(NW); await admin(db => db.query(`update agencies set timezone = $2 where id = $1`, [NW.org, afternoonZone()])) })

  it('50 overdue invoices -> 20 reminders in hour one, the rest wait; one summary says so', async () => {
    const actor = await merchantActor(NW)
    const qb = await connectSyntheticOffice(actor, 'quickbooks', { demoData: false })
    await mutateQboSynth(qb.id, s => { s.invoices = Array.from({ length: 50 }, (_, i) => overdue(i)) })
    const mb = await connectSyntheticMailbox(actor, 'ar@northwind-office.example')
    await drain()
    expect((await getSynthMail(mb.id)).sent).toHaveLength(20)
    const [a] = await officeAgents(NW)
    const waiting = await rows<{ status: string }>(`select status from office_actions where agent_id = $1 and status = 'queued'`, [a.id])
    expect(waiting).toHaveLength(30)
    const s = updates.filter(u => u.dedupeKey.startsWith('autonomy:found:'))
    expect(s.map(u => u.dedupeKey).sort()).toEqual([`autonomy:found:${mb.id}`, `autonomy:found:${qb.id}`].sort())
    // the owner's update counts every overdue invoice found (the 30 not sent yet are still waiting, not lost)
    expect(Math.max(...s.map(u => Number(u.proof.find(p => p.label === 'Found')?.value ?? 0)))).toBeGreaterThanOrEqual(50)
    // run the jobs again: no second summary
    await drain()
    expect(updates.filter(u => u.dedupeKey.startsWith('autonomy:found:'))).toHaveLength(2)
  })

  it('the hourly cap (pack settings) holds hour by hour: 5, then 5 more an hour later, with the hold recorded', async () => {
    const actor = await merchantActor(NW)
    await chooseBusinessType(actor, { businessType: 'office' })
    await updatePackConfig(actor, { firstRunHourlyCap: 5 })
    const qb = await connectSyntheticOffice(actor, 'quickbooks', { demoData: false })
    await mutateQboSynth(qb.id, s => { s.invoices = Array.from({ length: 12 }, (_, i) => overdue(i)) })
    const mb = await connectSyntheticMailbox(actor, 'ar@northwind-office.example')
    await drain()
    expect((await getSynthMail(mb.id)).sent).toHaveLength(5)
    const held = await rows<{ status_reason: string }>(`select status_reason from office_actions where org_id = $1 and status = 'queued' and status_reason like 'first-day pace%'`, [NW.org])
    expect(held.length).toBeGreaterThan(0)
    expect((await one<{ n: number }>(`select count(*)::int as n from autonomy_backlog where org_id = $1 and released_at is null`, [NW.org]))!.n).toBe(held.length)
    // the summary counts what is queued
    expect(updates.some(u => u.dedupeKey === `autonomy:found:${mb.id}` && u.proof.some(p => p.label === 'Queued for later hours' && Number(p.value) > 0))).toBe(true)
    await executeDue(NW.org, { now: new Date(T.getTime() + 62 * 60e3) })
    expect((await getSynthMail(mb.id)).sent).toHaveLength(10)
  })

  it('loop-level: 25 customer emails -> 20 now, 5 held with the handler queued for later; 25 internal fixes are never held', async () => {
    await admin(db => db.query(`insert into autonomy_connects (org_id, kind, connection_id, connected_at, status) values ($1,'office',gen_random_uuid(),$2,'done')`, [NW.org, T.toISOString()]))
    const spec = (k: string, actionType: string) => ({
      orgId: NW.org, agentKey: 'test_agent', agentName: 'Test agent', actionType, problemKey: `pace:${actionType}:${k}`, now: () => T,
      detect: async () => ({ k }), describe: () => ({ title: `Problem ${k}`, whatHappened: 'x', whatIDid: ['y'] }),
      act: async () => ({ proof: [{ label: 'did', value: k }] }), verify: async () => ({ ok: true, proof: [{ label: 'fresh read', value: k }] }),
    })
    const out: string[] = []
    const eventId = (await one<{ id: string }>(`insert into agent_events (org_id, source, type, external_id, occurred_at, payload, status, handlers) values ($1,'sweep','sweep','pace-test',now(),'{}','routed','{test_agent}') returning id`, [NW.org]))!.id
    await currentEvent.run({ eventId, agentKey: 'test_agent' }, async () => {
      for (let i = 0; i < 25; i++) out.push((await admin(db => runAgentLoop(db, spec(String(i), 'send_customer_email')))).status)
    })
    expect(out.filter(x => x === 'done')).toHaveLength(20)
    expect(out.filter(x => x === 'nothing_to_do')).toHaveLength(5)
    const requeued = await rows<{ run_after: string }>(`select run_after from jobs where org_id = $1 and kind = 'event.handle' and payload->>'eventId' = $2`, [NW.org, eventId])
    expect(requeued.length).toBeGreaterThan(0)
    expect(new Date(requeued[0].run_after).getTime()).toBeGreaterThan(T.getTime() + 59 * 60e3)
    const internal: string[] = []
    for (let i = 0; i < 25; i++) internal.push((await admin(db => runAgentLoop(db, spec(String(i), 'update_listing')))).status)
    expect(internal.every(x => x === 'done')).toBe(true)
    // an hour later there is room again
    expect((await admin(db => takeOutboundSlot(db, NW.org, 'late-one', {}, new Date(T.getTime() + 62 * 60e3)))).ok).toBe(true)
    await admin(db => db.query(`delete from jobs where org_id = $1 and kind = 'event.handle'`, [NW.org]))
  })

  it('a business connected before this release gets its packs from its existing connections (sweep or packs page); an owner choice is kept', async () => {
    await clean(NW)
    // the seeded store connection is active, but no pack_settings row exists (connected before packs switched on by themselves)
    expect(await one(`select 1 from pack_settings where org_id = $1`, [NW.org])).toBeNull()
    const view = await packsOverview(await merchantActor(NW))
    expect((await admin(db => orgPacks(db, NW.org))).packs).toEqual(expect.arrayContaining(['commerce', 'office']))
    expect(JSON.stringify(view)).toContain('commerce')
    expect(await one<{ source: string; inferred_from: string }>(`select source, inferred_from from pack_settings where org_id = $1`, [NW.org])).toEqual({ source: 'inferred', inferred_from: 'existing:store' })
    // the sweep does the same for a business nobody looks at
    await clean(NW)
    await emitSweep(new Date())
    expect((await admin(db => orgPacks(db, NW.org))).businessType).toBe('store')
    // an owner's choice is never replaced
    await chooseBusinessType(await merchantActor(NW), { businessType: 'office' })
    expect(await admin(db => inferFromConnections(db, NW.org))).toBe(false)
    expect((await admin(db => orgPacks(db, NW.org))).businessType).toBe('office')
  })
})
