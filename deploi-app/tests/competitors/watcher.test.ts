/**
 * Competitor & Trend Watcher end to end (local database, fake public stores): template -> grant -> runs ->
 * baseline -> changes -> insights -> alert draft -> handoff to a Supplier Chaser. Plus tenant isolation,
 * failed checks, pause, and the rule that monitoring never authorizes contact or changes.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { createAgent, grantPolicy, pauseAgent, editAgent } from '../../lib/agents/lifecycle'
import { runAgent } from '../../lib/agents/run'
import { parsePolicy } from '../../lib/agents/policy'
import { TEMPLATES, templatePolicy } from '../../lib/agents/templates'
import { agentWorkLog } from '../../lib/agents/worklog'
import { COMPETITOR_SOURCES, shopifyPublicSource } from '../../lib/competitors/sources/shopify-public'
import { competitorOverview, competitorProducts, competitorProductHistory } from '../../lib/competitors/queries'
import { handOffInsight } from '../../lib/competitors/handoff'
import { approveMessage } from '../../lib/email/engine'
import { NW, HB, merchantActor, resetMerchant, store } from '../merchant/helpers'
import { fakeFetcher, product, type FakeStore } from './fake-store'

const ready = await prepareDb()
const DOMAIN = 'agents.test.deploi'
const OWNER = 'owner@northwind-goods.example'
const SUPPLIER = 'orders@supplier.example'
const original = COMPETITOR_SOURCES.shopify_public

const A = 'https://alpha-shop.example.com', B = 'https://beta-goods.example.net', C = 'https://gamma.example.org', D = 'https://not-shopify.example.com'
let stores: Record<string, FakeStore>
let log: string[]

function baseStores(): Record<string, FakeStore> {
  return {
    [A]: { products: [product(1, 'Leather wallet', '40.00'), product(2, 'Canvas tote', '30.00')], bestsellers: { handle: 'best-sellers', ids: [2] } },
    [B]: { products: [product(11, 'Water bottle', '20.00'), product(12, 'Day pack', '70.00')] },
    [C]: { products: [product(21, 'Phone case', '15.00')], currency: 'EUR' },
    [D]: { products: [], html: true },
  }
}

async function watcher(actor: Awaited<ReturnType<typeof merchantActor>>, extra: { notify?: string } = {}) {
  const raw = templatePolicy('competitor_watcher', { connectionId: NW.conn, timezone: 'UTC', notify: extra.notify ?? null,
    competitor: { stores: [{ url: A }, { url: B }, { url: C }, { url: D }], keywords: ['travel organizer'] } })
  const c = await createAgent(actor, { name: 'Competitor Watch', taskText: TEMPLATES[3].job, policy: raw, mailbox: Boolean(extra.notify), templateKey: 'competitor_watcher' })
  await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
  return c
}
const at = (iso: string) => new Date(iso)
const insightsOf = (agentId: string) => admin(db => db.query<{ id: string; kind: string; basis: string; headline: string; meaningful: boolean; products: { title: string }[]; limitations: string[]; status: string; alerted_at: string | null }>(
  'select id, kind, basis, headline, meaningful, products, limitations, status, alerted_at from competitor_insights where agent_id = $1 order by created_at, kind', [agentId]))

describe.skipIf(!ready)('Competitor & Trend Watcher', () => {
  beforeEach(async () => {
    process.env.AGENT_MAIL_DOMAIN = DOMAIN
    process.env.COMPETITOR_REQUEST_DELAY_MS = '0'
    stores = baseStores(); log = []
    COMPETITOR_SOURCES.shopify_public = () => shopifyPublicSource(fakeFetcher(stores, log))
    await resetMerchant(NW, { ruleOn: false }); await resetMerchant(HB, { ruleOn: false })
  })
  afterEach(() => { COMPETITOR_SOURCES.shopify_public = original; delete process.env.AGENT_MAIL_DOMAIN; delete process.env.COMPETITOR_REQUEST_DELAY_MS })

  it('the template is drafts-only monitoring: it never reads or writes the merchant’s store and the summary says so', async () => {
    const actor = await merchantActor(NW)
    const c = await watcher(actor)
    const p = parsePolicy(templatePolicy('competitor_watcher', { connectionId: NW.conn, timezone: 'UTC', competitor: { stores: [{ url: A }] } }))
    expect(p).toMatchObject({ approvalMode: 'draft', correctionTypes: [], watch: [] })
    expect(c.summary.never.join(' ')).toMatch(/Never reads, changes or writes anything in your own store/)
    expect(c.summary.never.join(' ')).toMatch(/Never claims a competitor’s sales/)
    expect(() => parsePolicy({ ...p, approvalMode: 'autonomous' })).toThrow()
    expect(() => parsePolicy({ ...p, correctionTypes: ['oversell_policy'] })).toThrow()
    expect(() => parsePolicy({ ...p, competitor: { stores: [{ url: 'http://169.254.169.254/latest' }] } })).toThrow(/IP address/)
    expect(() => parsePolicy({ ...p, schedule: { kind: 'interval', everyHours: 1 } })).toThrow(/6 hours/)
    const writes = (await store(NW))!.writeLog.length
    await runAgent(c.agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-01T06:30:00Z') })
    expect((await store(NW))!.writeLog.length).toBe(writes)
    const scans = await admin(db => db.one<{ n: string }>('select count(*)::text as n from scans where agent_id = $1', [c.agentId]))
    expect(Number(scans!.n)).toBe(0)
  })

  it('baseline first, then real changes; failed and unsupported stores are honest and never create findings about products', async () => {
    const actor = await merchantActor(NW)
    const { agentId } = await watcher(actor)
    const r1 = await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-01T06:30:00Z') })
    expect(r1.status).toBe('completed')
    expect(r1.counts.competitor).toMatchObject({ storesChecked: 4, storesComplete: 3, storesFailed: 1 })
    let ins = await insightsOf(agentId)
    expect(ins.filter(i => i.kind === 'baseline')).toHaveLength(3)
    expect(ins.filter(i => i.kind === 'launches')).toHaveLength(0)
    expect(ins.find(i => i.kind === 'source_unavailable')).toMatchObject({ basis: 'unavailable', headline: 'not-shopify.example.com could not be checked' })

    // day 2: alpha launches two travel organizers and discounts the wallet; beta goes down (outage); gamma unchanged
    stores[A].products.push(product(3, 'Travel organizer XL', '35.00', { published_at: '2026-10-01T12:00:00Z', tags: ['travel'] }), product(4, 'Mini travel organizer', '22.00', { published_at: '2026-10-01T13:00:00Z' }))
    stores[A].products[0] = product(1, 'Leather wallet', '30.00', {}, { compare_at_price: '40.00' })
    stores[A].bestsellers = { handle: 'best-sellers', ids: [3, 2, 1] }
    stores[B].down = 503
    await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-02T06:30:00Z') })
    ins = await insightsOf(agentId)
    expect(ins.find(i => i.kind === 'launches')).toMatchObject({ basis: 'observed', headline: 'alpha-shop.example.com added 2 new products', meaningful: true })
    expect(ins.find(i => i.kind === 'price_changes')).toMatchObject({ meaningful: true })
    expect(ins.find(i => i.kind === 'promotions')).toBeTruthy()
    // an existing product moving into the store's own bestseller collection (a new product's position is part of its launch)
    expect(ins.find(i => i.kind === 'bestseller_entries')!.products.map(p => p.title)).toEqual(['Leather wallet'])
    // beta failed once: no findings about its products, and not yet an outage note
    expect(ins.filter(i => i.kind === 'delisted')).toEqual([])
    const beta = (await competitorOverview(actor, agentId)).stores.find(s => s.domain === 'beta-goods.example.net') as unknown as { status: string; last_success_at: string; consecutive_failures: number }
    expect(beta.status).toBe('error')
    expect(beta.consecutive_failures).toBe(1)
    expect(new Date(beta.last_success_at).toISOString()).toBe('2026-10-01T06:30:00.000Z')

    // day 3: beta comes back WITHOUT the day pack -> one complete check missing it is not enough; day 4 confirms
    stores[B].down = null
    stores[B].products = [stores[B].products[0], product(13, 'Travel organizer', '18.00', { published_at: '2026-10-02T10:00:00Z' })]
    await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-03T06:30:00Z') })
    ins = await insightsOf(agentId)
    expect(ins.filter(i => i.kind === 'delisted')).toEqual([])
    // two stores added travel organizers within 7 days: an inferred pattern among followed stores
    const pattern = ins.find(i => i.kind === 'cross_store_pattern')!
    expect(pattern).toMatchObject({ basis: 'inferred', headline: '2 of the 4 stores you follow added travel organizer products in the last 7 days' })
    expect(pattern.limitations.join(' ')).toMatch(/not a wider market trend/)
    await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-04T06:30:00Z') })
    ins = await insightsOf(agentId)
    expect(ins.find(i => i.kind === 'delisted')).toMatchObject({ basis: 'observed', headline: '1 product no longer listed at beta-goods.example.net' })
    // the same pattern is not reported again on the next run
    expect(ins.filter(i => i.kind === 'cross_store_pattern')).toHaveLength(1)
    // nothing ever claims sales
    expect(JSON.stringify(ins)).not.toMatch(/units sold|revenue of|sold \d+|best-selling product/i)
  })

  it('price history and the comparison view never mix currencies', async () => {
    const actor = await merchantActor(NW)
    const { agentId } = await watcher(actor)
    await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-01T06:30:00Z') })
    stores[A].products[0] = product(1, 'Leather wallet', '30.00')
    await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-02T06:30:00Z') })
    await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-03T06:30:00Z') })
    const list = await competitorProducts(actor, agentId, { q: 'wallet' }) as { id: string; currency: string; price_min: string }[]
    expect(list).toHaveLength(1)
    const h = await competitorProductHistory(actor, agentId, list[0].id) as unknown as { history: { price_min: string; observed_at: string; last_confirmed_at: string }[] }
    // change-only: two observations (40, then 30 confirmed on day 3)
    expect(h.history.map(x => Number(x.price_min))).toEqual([30, 40])
    expect(new Date(h.history[0].last_confirmed_at).toISOString()).toBe('2026-10-03T06:30:00.000Z')
    const all = await competitorProducts(actor, agentId, {}) as { store: string; currency: string }[]
    expect(all.find(p => p.store === 'gamma.example.org')!.currency).toBe('EUR')
    expect(all.find(p => p.store === 'alpha-shop.example.com')!.currency).toBe('USD')
  })

  it('alerts are drafts to the merchant only, once per finding', async () => {
    const actor = await merchantActor(NW)
    const { agentId } = await watcher(actor, { notify: OWNER })
    await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-01T06:30:00Z') })
    stores[A].products.push(product(3, 'Travel organizer XL', '35.00', { published_at: '2026-10-01T12:00:00Z' }))
    await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-02T06:30:00Z') })
    await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-03T06:30:00Z') })
    const mails = await admin(db => db.query<{ task_key: string; status: string; to_addresses: string[] }>('select task_key, status, to_addresses from email_messages where agent_id = $1', [agentId]))
    expect(mails).toEqual([{ task_key: 'competitor_alert', status: 'draft', to_addresses: [OWNER] }])
  })

  it('handoff: a finding becomes a sourcing-request draft for a Supplier Chaser with its evidence, never sent automatically', async () => {
    const actor = await merchantActor(NW)
    const { agentId } = await watcher(actor)
    await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-01T06:30:00Z') })
    stores[A].products.push(product(3, 'Travel organizer XL', '35.00', { published_at: '2026-10-01T12:00:00Z' }))
    await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-02T06:30:00Z') })
    const launch = (await insightsOf(agentId)).find(i => i.kind === 'launches')!

    // a Supplier Chaser that may send after approval: the handoff still waits for approval of the exact message
    const raw = templatePolicy('supplier_chaser', { connectionId: NW.conn, timezone: 'UTC', supplierAddress: SUPPLIER }) as Record<string, unknown>
    const sc = await createAgent(actor, { name: 'Supplier Chaser', taskText: TEMPLATES[1].job, policy: { ...raw, email: { ...(raw.email as object), permission: 'send_approved' } }, mailbox: true, templateKey: 'supplier_chaser' })
    await grantPolicy(actor, sc.agentId, sc.policyId, sc.policyHash)
    const h = await handOffInsight(actor, launch.id, { supplierAgentId: sc.agentId, note: 'Looking for 200 units' })
    expect(h).toMatchObject({ status: 'awaiting_approval', duplicate: false })
    const msg = await admin(db => db.one<{ task_key: string; to_addresses: string[]; status: string; meta: { evidence: { sources: unknown[]; products: { title: string; url: string }[] }; insight_id: string } }>('select task_key, to_addresses, status, meta from email_messages where id = $1', [h.messageId]))
    expect(msg).toMatchObject({ task_key: 'sourcing_request', to_addresses: [SUPPLIER], status: 'awaiting_approval' })
    expect(msg!.meta.insight_id).toBe(launch.id)
    expect(msg!.meta.evidence.products[0]).toMatchObject({ title: 'Travel organizer XL', url: `${A}/products/p-3` })
    expect(msg!.meta.evidence.sources.length).toBeGreaterThan(0)
    // a second click returns the same message
    expect(await handOffInsight(actor, launch.id, { supplierAgentId: sc.agentId })).toMatchObject({ messageId: h.messageId, duplicate: true })
    // both work logs record the link
    expect((await agentWorkLog(actor, agentId)).some(e => e.event === 'competitor.handed_off')).toBe(true)
    expect((await agentWorkLog(actor, sc.agentId)).some(e => e.event === 'email.handoff_received')).toBe(true)
    // the default (drafts-only) Supplier Chaser gets a draft that cannot be approved for sending
    const sc2 = await createAgent(actor, { name: 'Drafts Chaser', taskText: '', policy: templatePolicy('supplier_chaser', { connectionId: NW.conn, timezone: 'UTC', supplierAddress: SUPPLIER }), mailbox: true })
    await grantPolicy(actor, sc2.agentId, sc2.policyId, sc2.policyHash)
    const h2 = await handOffInsight(actor, launch.id, { supplierAgentId: sc2.agentId })
    expect(h2.status).toBe('draft')
    const hash = (await admin(db => db.one<{ content_hash: string }>('select content_hash from email_messages where id = $1', [h2.messageId])))!.content_hash
    await expect(approveMessage(actor, h2.messageId, hash)).rejects.toMatchObject({ code: 'not_pending' })
  })

  it('tenant isolation: another merchant cannot read findings, products or hand them off', async () => {
    const actor = await merchantActor(NW)
    const { agentId } = await watcher(actor)
    await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-01T06:30:00Z') })
    const other = await merchantActor(HB)
    await expect(competitorOverview(other, agentId)).rejects.toMatchObject({ code: 'not_found' })
    await expect(competitorProducts(other, agentId, {})).rejects.toMatchObject({ code: 'not_found' })
    const ins = (await insightsOf(agentId))[0]
    const raw = templatePolicy('supplier_chaser', { connectionId: HB.conn, timezone: 'UTC', supplierAddress: SUPPLIER })
    const hbChaser = await createAgent(other, { name: 'HB chaser', taskText: '', policy: raw, mailbox: true })
    await grantPolicy(other, hbChaser.agentId, hbChaser.policyId, hbChaser.policyHash)
    await expect(handOffInsight(other, ins.id, { supplierAgentId: hbChaser.agentId })).rejects.toMatchObject({ code: 'not_found' })
    // and NW cannot hand its finding to HB's agent
    await expect(handOffInsight(actor, ins.id, { supplierAgentId: hbChaser.agentId })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('pausing stops checks; removing a store keeps its history and stops reading it', async () => {
    const actor = await merchantActor(NW)
    const { agentId } = await watcher(actor)
    await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-01T06:30:00Z') })
    await pauseAgent(actor, agentId)
    const before = log.length
    await expect(runAgent(agentId, { trigger: 'test', actor: actor.label })).rejects.toMatchObject({ code: 'agent_inactive' })
    expect(log.length).toBe(before)
    const { resumeAgent } = await import('../../lib/agents/lifecycle')
    await resumeAgent(actor, agentId)
    // narrowing: fewer stores applies without a new grant; adding one needs a grant
    const narrower = templatePolicy('competitor_watcher', { connectionId: NW.conn, timezone: 'UTC', competitor: { stores: [{ url: A }], keywords: ['travel organizer'] } })
    const e1 = await editAgent(actor, agentId, { policy: narrower })
    expect(e1.requiresGrant).toBe(false)
    log.length = 0
    await runAgent(agentId, { trigger: 'test', actor: actor.label, now: at('2026-10-02T06:30:00Z') })
    expect(log.every(u => u.startsWith(A))).toBe(true)
    const wider = templatePolicy('competitor_watcher', { connectionId: NW.conn, timezone: 'UTC', competitor: { stores: [{ url: A }, { url: 'https://new-store.example.com' }] } })
    const e2 = await editAgent(actor, agentId, { policy: wider })
    expect(e2.requiresGrant).toBe(true)
    expect(e2.expansion).toContain('more competitor stores watched')
  })
})
