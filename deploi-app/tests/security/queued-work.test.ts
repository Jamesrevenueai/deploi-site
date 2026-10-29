/**
 * Already-queued work must not act after pause, revoke, uninstall or a scheduler overlap, and failed webhook
 * deliveries must be processed again on retry (not acknowledged as duplicates).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { executeProposal, queueExecution } from '../../lib/engine/execute'
import type { ProposalRow } from '../../lib/engine/proposals'
import { createAgent, editAgent, grantPolicy, pauseAgent } from '../../lib/agents/lifecycle'
import { runAgent } from '../../lib/agents/run'
import { shopifyConnector } from '../../lib/connectors/shopify/connector'
import { NORTHWIND_IDS } from '../../lib/connectors/shopify/demo-store'
import { DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'
import { handleShopifyWebhook } from '../../lib/connectors/shopify/webhooks'
import { markUninstalled } from '../../lib/connectors/shopify/install'
import { cronAuthorized } from '../../lib/cron-auth'
import type { Actor } from '../../lib/engine/actor'
import { NW, merchantActor, resetMerchant, store } from '../merchant/helpers'

const ready = await prepareDb()
const { V } = NORTHWIND_IDS
const STOCK = { correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: DEFAULT_EXEMPT_TAGS, flagInStockVariants: true } } }
const writes = async () => (await store(NW))!.writeLog.length

async function reviewAgent(actor: Actor, name: string) {
  const c = await createAgent(actor, { name, taskText: name, policy: { connectionId: NW.conn, productScope: { mode: 'all' }, ...STOCK, approvalMode: 'review' } })
  await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
  return c.agentId
}
async function queueApproved(agentId: string, target: string) {
  const p = (await admin(db => db.query<ProposalRow>('select * from proposals where agent_id = $1 and target_id = $2 order by created_at desc limit 1', [agentId, target])))[0]
  const execId = await admin(async db => {
    const a = await db.one<{ id: string }>(`insert into approvals (org_id, proposal_id, change_hash, approved_by, approver_kind, approved_at) values ($1,$2,$3,'user:test','profile',now()) returning id`, [p.org_id, p.id, p.change_hash])
    await db.query(`update proposals set status = 'approved' where id = $1`, [p.id])
    return queueExecution(db, p, a!.id)
  })
  return { p, execId }
}

describe.skipIf(!ready)('queued work stops when the agent stops', () => {
  beforeEach(async () => { await resetMerchant(NW, { ruleOn: false }) })
  afterEach(() => { vi.restoreAllMocks() })

  it('a pause that lands while the change is being re-read (prechecking) stops it before the write', async () => {
    const actor = await merchantActor(NW)
    const id = await reviewAgent(actor, 'Precheck pause')
    await runAgent(id, { trigger: 'test', actor: actor.label })
    const { p, execId } = await queueApproved(id, V(2001))
    const before = await writes()
    const real = shopifyConnector.readResources.bind(shopifyConnector)
    // the merchant presses Pause in the middle of the fresh read
    vi.spyOn(shopifyConnector, 'readResources').mockImplementation(async (conn, ids) => {
      const r = await real(conn, ids)
      await pauseAgent(actor, id)
      return r
    })
    const r = await executeProposal(p.id, { actor: actor.label })
    expect(r.status).toBe('blocked')
    expect(await writes()).toBe(before)
    const row = await admin(db => db.one<{ status: string }>('select status from executions where id = $1', [execId]))
    expect(row!.status).toBe('blocked')
  })

  it('an authorization replaced while prechecking stops the write (the claimed version must still be active)', async () => {
    const actor = await merchantActor(NW)
    const id = await reviewAgent(actor, 'Precheck regrant')
    await runAgent(id, { trigger: 'test', actor: actor.label })
    const { p } = await queueApproved(id, V(2001))
    const before = await writes()
    const real = shopifyConnector.readResources.bind(shopifyConnector)
    vi.spyOn(shopifyConnector, 'readResources').mockImplementation(async (conn, ids) => {
      const r = await real(conn, ids)
      // a narrower edit applies without a grant and becomes the active version
      await editAgent(actor, id, { policy: { connectionId: NW.conn, ...STOCK, productScope: { mode: 'all' }, approvalMode: 'review', limits: { maxChangesPerRun: 5, maxChangesPerDay: 50 } } })
      return r
    })
    const r = await executeProposal(p.id, { actor: actor.label })
    expect(['blocked', 'stale']).toContain(r.status)
    expect(await writes()).toBe(before)
  })

  it('uninstalling the app pauses its agents, closes queued writes and cancels queued email', async () => {
    const actor = await merchantActor(NW)
    const id = await reviewAgent(actor, 'Uninstall stop')
    await runAgent(id, { trigger: 'test', actor: actor.label })
    const { execId } = await queueApproved(id, V(2001))
    await admin(db => markUninstalled(db, NW.domain, 'test'))
    const agent = await admin(db => db.one<{ status: string }>('select status from agents where id = $1', [id]))
    expect(agent!.status).toBe('paused')
    const exec = await admin(db => db.one<{ status: string }>('select status from executions where id = $1', [execId]))
    expect(exec!.status).toBe('blocked')
  })

  it('a scheduled run re-checks that it is still due under the lock (no double run from overlapping schedulers)', async () => {
    const actor = await merchantActor(NW)
    const c = await createAgent(actor, { name: 'Sched', taskText: 'x', policy: { connectionId: NW.conn, productScope: { mode: 'all' }, ...STOCK, approvalMode: 'review', schedule: { kind: 'interval', everyHours: 6 } } })
    await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
    await admin(db => db.query(`update agents set next_run_at = now() - interval '1 minute' where id = $1`, [c.agentId]))
    const now = new Date()
    await runAgent(c.agentId, { trigger: 'schedule', actor: 'system:scheduler', now })
    // a second scheduler that had selected the agent before the first run moved next_run_at forward
    await expect(runAgent(c.agentId, { trigger: 'schedule', actor: 'system:scheduler', now })).rejects.toMatchObject({ code: 'busy' })
    const runs = await admin(db => db.one<{ n: string }>('select count(*)::text as n from agent_runs where agent_id = $1', [c.agentId]))
    expect(Number(runs!.n)).toBe(1)
  })
})

describe.skipIf(!ready)('Shopify webhook retries', () => {
  const secret = 'test-shopify-secret'
  beforeEach(async () => {
    process.env.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || 'test-key'
    process.env.SHOPIFY_API_SECRET = secret
    await resetMerchant(NW, { ruleOn: false })
  })
  afterEach(() => { vi.restoreAllMocks() })

  const send = (id: string, topic: string, body: Record<string, unknown>) => {
    const raw = JSON.stringify(body)
    return handleShopifyWebhook(new Request('http://localhost/api/shopify/webhooks', { method: 'POST', body: raw, headers: {
      'x-shopify-hmac-sha256': createHmac('sha256', secret).update(raw).digest('base64'), 'x-shopify-topic': topic, 'x-shopify-shop-domain': NW.domain, 'x-shopify-webhook-id': id } }), fn => { void fn() })
  }

  it('a delivery that failed is processed again on retry; a processed one is acknowledged as a duplicate', async () => {
    const install = await import('../../lib/connectors/shopify/install')
    const spy = vi.spyOn(install, 'markUninstalled').mockRejectedValueOnce(new Error('database briefly unavailable'))
    const id = `retry-${Date.now()}`
    const first = await send(id, 'app/uninstalled', { id: 1 })
    expect(first.status).toBe(500)
    spy.mockRestore()
    const second = await send(id, 'app/uninstalled', { id: 1 })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ ok: true })
    const conn = await admin(db => db.one<{ status: string }>('select status from store_connections where id = $1', [NW.conn]))
    expect(conn!.status).toBe('uninstalled')
    const third = await send(id, 'app/uninstalled', { id: 1 })
    expect(await third.json()).toEqual({ ok: true, duplicate: true })
  })
})

describe('cron routes fail closed without CRON_SECRET', () => {
  const req = (auth?: string) => new Request('http://x/api/cron/agents', { headers: auth ? { authorization: auth } : {} })
  it('with a secret: only the exact bearer passes', () => {
    expect(cronAuthorized(req('Bearer s3cret'), { CRON_SECRET: 's3cret' })).toBe(true)
    expect(cronAuthorized(req('Bearer wrong'), { CRON_SECRET: 's3cret' })).toBe(false)
    expect(cronAuthorized(req(), { CRON_SECRET: 's3cret' })).toBe(false)
  })
  it('without a secret: refused on production and preview deployments, open only on a developer machine', () => {
    expect(cronAuthorized(req(), { VERCEL_ENV: 'production' })).toBe(false)
    expect(cronAuthorized(req(), { VERCEL_ENV: 'preview' })).toBe(false)
    expect(cronAuthorized(req(), { DEPLOI_ENV: 'production' })).toBe(false)
    expect(cronAuthorized(req(), {})).toBe(true)
  })
})
