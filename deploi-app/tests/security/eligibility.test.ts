/** Write eligibility for real stores (migration 34) and the install lock. */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { storeEligibility } from '../../lib/connectors/eligibility'
import { ensureInstalled } from '../../lib/connectors/shopify/install'
import { executeProposal, queueExecution } from '../../lib/engine/execute'
import type { ProposalRow } from '../../lib/engine/proposals'
import { createAgent, grantPolicy } from '../../lib/agents/lifecycle'
import { runAgent } from '../../lib/agents/run'
import { DEFAULT_EXEMPT_TAGS } from '../../lib/connectors/shopify/checks'
import { NW, merchantActor, resetMerchant } from '../merchant/helpers'

const ready = await prepareDb()
const SHOP = 'eligibility-test.myshopify.com'
const clear = () => admin(db => db.query(`delete from store_eligibility where shop in ($1, $2)`, [SHOP, NW.domain]))

describe.skipIf(!ready)('store eligibility', () => {
  beforeEach(async () => { await clear(); delete process.env.LIVE_WRITE_STORES; delete process.env.LIVE_WRITES })
  afterEach(clear)

  it('a real store without a row may not be written to, with a plain reason; synthetic stores always may', async () => {
    await admin(async db => {
      expect(await storeEligibility(db, SHOP, false)).toMatchObject({ tier: 'none', liveWrites: false, reason: expect.stringMatching(/beta/) })
      expect((await storeEligibility(db, SHOP, true)).liveWrites).toBe(true)
    })
  })
  it('beta allows writes; review must end and stops after its end date; blocked never writes', async () => {
    await admin(async db => {
      await db.query(`insert into store_eligibility (shop, tier, live_writes, granted_by) values ($1, 'beta', true, 'staff:test')`, [SHOP])
      expect((await storeEligibility(db, SHOP, false)).liveWrites).toBe(true)
    })
    // a review row must have an end date (its own transaction: the refusal aborts it)
    await expect(admin(db => db.query(`update store_eligibility set tier = 'review', expires_at = null where shop = $1`, [SHOP]))).rejects.toThrow()
    await admin(async db => {
      await db.query(`update store_eligibility set tier = 'review', expires_at = now() - interval '1 day' where shop = $1`, [SHOP])
      expect(await storeEligibility(db, SHOP, false)).toMatchObject({ liveWrites: false, reason: expect.stringMatching(/ended/) })
      await db.query(`update store_eligibility set tier = 'blocked', live_writes = false, expires_at = null where shop = $1`, [SHOP])
      expect((await storeEligibility(db, SHOP, false)).tier).toBe('blocked')
    })
  })
  it('LIVE_WRITE_STORES still enables a development store locally, but never overrides blocked', async () => {
    process.env.LIVE_WRITE_STORES = SHOP
    await admin(async db => {
      expect((await storeEligibility(db, SHOP, false)).liveWrites).toBe(true)
      await db.query(`insert into store_eligibility (shop, tier, live_writes, granted_by) values ($1, 'blocked', false, 'staff:test')`, [SHOP])
      expect((await storeEligibility(db, SHOP, false)).liveWrites).toBe(false)
    })
  })
  it('an approved change to an ineligible real store is blocked before any request, with the reason', async () => {
    await resetMerchant(NW, { ruleOn: false })
    const actor = await merchantActor(NW)
    const c = await createAgent(actor, { name: 'Elig', taskText: 'x', policy: { connectionId: NW.conn, productScope: { mode: 'all' }, correctionTypes: ['oversell_policy'], rules: { oversell_policy: { exemptTags: DEFAULT_EXEMPT_TAGS, flagInStockVariants: true } }, approvalMode: 'review' } })
    await grantPolicy(actor, c.agentId, c.policyId, c.policyHash)
    await runAgent(c.agentId, { trigger: 'test', actor: actor.label })
    const p = (await admin(db => db.query<ProposalRow>('select * from proposals where agent_id = $1 limit 1', [c.agentId])))[0]
    await admin(async db => {
      const a = await db.one<{ id: string }>(`insert into approvals (org_id, proposal_id, change_hash, approved_by, approver_kind, approved_at) values ($1,$2,$3,'user:test','profile',now()) returning id`, [p.org_id, p.id, p.change_hash])
      await db.query(`update proposals set status = 'approved' where id = $1`, [p.id])
      await queueExecution(db, p, a!.id)
      // now treat the store as real (no network is reached: the gate refuses first)
      await db.query('update store_connections set is_synthetic = false where id = $1', [NW.conn])
    })
    const r = await executeProposal(p.id, { actor: actor.label })
    expect(r).toMatchObject({ status: 'blocked', reason: expect.stringMatching(/not enabled yet/) })
    await admin(db => db.query('update store_connections set is_synthetic = true where id = $1', [NW.conn]))
  })
  it('a blocked shop cannot install, and two concurrent first installs create one organization', async () => {
    await admin(db => db.query(`insert into store_eligibility (shop, tier, live_writes, granted_by) values ($1, 'blocked', false, 'staff:test')`, [SHOP]))
    const deps = { exchange: async () => ({ accessToken: 'shpat_test', scope: ['read_products'], expiresAt: null, refreshToken: null, refreshExpiresAt: null }) as never, info: async () => ({ name: 'Elig shop', timezone: 'UTC', currency: 'USD' }) }
    await expect(ensureInstalled(SHOP, 'id-token', deps)).rejects.toThrow(/blocked/)
    await clear()
    const shop2 = 'concurrent-install.myshopify.com'
    await admin(async db => { await db.query('delete from store_connections where external_id = $1', [shop2]); await db.query(`delete from agencies where name = 'Elig shop' and org_type = 'merchant'`) })
    // both installs reach the transaction at the same moment (a barrier after the shop lookup)
    let arrived = 0, release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const raced = { ...deps, info: async () => { if (++arrived === 2) release(); await gate; return deps.info() } }
    const [a, b] = await Promise.all([ensureInstalled(shop2, 't', raced), ensureInstalled(shop2, 't', raced)])
    expect(a.orgId).toBe(b.orgId)
    const orgs = await admin(db => db.one<{ n: string }>(`select count(*)::text as n from agencies where name = 'Elig shop'`))
    expect(Number(orgs!.n)).toBe(1)
  })
})
