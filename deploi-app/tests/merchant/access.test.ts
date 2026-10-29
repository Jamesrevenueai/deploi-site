import './env'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { runScan } from '../../lib/engine/scan'
import { loadConnection } from '../../lib/engine/scan'
import { approveProposal } from '../../lib/engine/approve'
import { executeProposal } from '../../lib/engine/execute'
import { setTransportOverride } from '../../lib/connectors/shopify/client'
import { syntheticTransport } from '../../lib/connectors/shopify/synthetic'
import { ensureInstalled, parseShopInfo } from '../../lib/connectors/shopify/install'
import { handleShopifyWebhook } from '../../lib/connectors/shopify/webhooks'
import { signSessionToken } from '../../lib/connectors/shopify/auth'
import { NORTHWIND_IDS } from '../../lib/connectors/shopify/demo-store'
import { decide, getAccess, createInvite, redeemInvite, requestAccess, decideAccess, revokeInvite, writeBlockReason, emailBlockReason, recordShopFacts, hashCode, loadAccessRow } from '../../lib/engine/access'
import { GET as getAccessRoute, POST as postAccessRoute } from '../../app/api/store/access/route'
import { NW, HB, resetMerchant, merchantActor } from './helpers'

const ready = await prepareDb()
const SECRET = process.env.SHOPIFY_API_SECRET!
const KEY = process.env.SHOPIFY_API_KEY!
const bearer = (shop: string) => ({ authorization: `Bearer ${signSessionToken({ dest: `https://${shop}`, sub: '7' }, SECRET, KEY)}`, 'content-type': 'application/json' })
const inline = (fn: () => Promise<void>) => { void fn() }
const V = NORTHWIND_IDS.V

/** Northwind as a real (non-synthetic) store whose Shopify calls still go to the synthetic transport. */
async function asRealStore() {
  setTransportOverride(conn => syntheticTransport(conn.id))
  await admin(db => db.query('update store_connections set is_synthetic = false where id = $1', [NW.conn]))
  return (await admin(db => loadConnection(db, NW.conn)))!
}
async function proposalFor(variant: string) {
  return admin(db => db.one<{ id: string; change_hash: string }>(`select p.id, p.change_hash from proposals p where p.connection_id = $1 and p.target_id = $2 and p.status = 'pending_approval'`, [NW.conn, variant]))
}

describe('access rules (pure)', () => {
  it('staff denial wins, then staff approval, invite, development store, open mode; otherwise pending', () => {
    const none = { staff_decision: null, invite_id: null, is_development_store: null }
    expect(decide(none, 'beta')).toEqual({ status: 'pending', basis: null })
    expect(decide(null, 'open')).toEqual({ status: 'eligible', basis: 'open_access' })
    expect(decide({ ...none, is_development_store: true }, 'beta')).toEqual({ status: 'eligible', basis: 'development_store' })
    expect(decide({ ...none, is_development_store: false }, 'beta')).toEqual({ status: 'pending', basis: null })
    expect(decide({ ...none, invite_id: 'x' }, 'beta')).toEqual({ status: 'eligible', basis: 'beta_invite' })
    expect(decide({ ...none, staff_decision: 'approved' }, 'beta')).toEqual({ status: 'eligible', basis: 'staff_approved' })
    expect(decide({ staff_decision: 'denied', invite_id: 'x', is_development_store: true }, 'open')).toEqual({ status: 'denied', basis: null })
  })

  it('reads the development-store flag from Shopify’s shop.plan, and treats a missing flag as unknown', () => {
    expect(parseShopInfo('a.myshopify.com', { data: { shop: { name: 'A', plan: { publicDisplayName: 'Development', partnerDevelopment: true } } } })).toMatchObject({ isDevelopmentStore: true, planName: 'Development' })
    expect(parseShopInfo('a.myshopify.com', { data: { shop: { name: 'A', plan: { publicDisplayName: 'Basic', partnerDevelopment: false } } } })).toMatchObject({ isDevelopmentStore: false })
    expect(parseShopInfo('a.myshopify.com', { data: { shop: { name: 'A' } } })).toMatchObject({ isDevelopmentStore: null, planName: null })
  })
})

describe.skipIf(!ready)('store access (beta eligibility) replaces the live-write allowlist', () => {
  beforeEach(async () => { await resetMerchant(NW); await resetMerchant(HB) })
  afterEach(async () => {
    setTransportOverride(null)
    delete process.env.STORE_ACCESS_MODE
    delete process.env.LIVE_WRITES
    await admin(db => db.query('update store_connections set is_synthetic = true where id = any($1)', [[NW.conn, HB.conn]]))
  })

  it('a development store is enabled at install; a paid store waits, and shop/redact erases its access record', async () => {
    const exchange = async () => ({ accessToken: 'shpat_access_test', scope: ['read_products', 'write_products'], expiresIn: 3600, refreshToken: 'shprt_access_test', refreshTokenExpiresIn: 7776000 })
    const dev = `access-dev-${Date.now()}.myshopify.com`
    const paid = `access-paid-${Date.now()}.myshopify.com`
    const d = await ensureInstalled(dev, 'id', { exchange, info: async () => ({ name: 'Dev (synthetic)', timezone: 'UTC', isDevelopmentStore: true, planName: 'Developer Preview' }) })
    const p = await ensureInstalled(paid, 'id', { exchange, info: async () => ({ name: 'Paid (synthetic)', timezone: 'UTC', isDevelopmentStore: false, planName: 'Basic' }) })
    const dc = (await admin(db => loadConnection(db, d.connectionId)))!
    const pc = (await admin(db => loadConnection(db, p.connectionId)))!
    expect(await admin(db => getAccess(db, dc))).toMatchObject({ eligible: true, basis: 'development_store' })
    expect(await admin(db => getAccess(db, pc))).toMatchObject({ eligible: false, status: 'pending' })
    expect(await admin(db => writeBlockReason(db, pc))).toBe('this store is not enabled for changes yet (beta access)')
    const events = await admin(db => db.query<{ event: string }>(`select event from engine_audit where connection_id = $1 and entity_type = 'access' order by id`, [d.connectionId]))
    expect(events.map(e => e.event)).toContain('access.eligible')
    for (const shop of [dev, paid]) {
      const sign = (raw: string) => createHmac('sha256', SECRET).update(raw).digest('base64')
      for (const topic of ['app/uninstalled', 'shop/redact']) {
        const raw = JSON.stringify({ shop_domain: shop })
        await handleShopifyWebhook(new Request('http://localhost/api/shopify/webhooks', { method: 'POST', body: raw, headers: { 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-webhook-id': `wh-${topic}-${shop}`, 'x-shopify-hmac-sha256': sign(raw) } }), inline)
      }
      expect(await admin(db => loadAccessRow(db, 'shopify', shop))).toBeNull()
    }
  })

  it('a waiting store is scanned and reviewed but never written; an invite enables it and the same change then runs', async () => {
    await runScan(NW.conn, { trigger: 'test' })
    const actor = await merchantActor(NW)
    const conn = await asRealStore()
    let p = (await proposalFor(V(2001)))!
    await approveProposal(actor, p.id, p.change_hash)
    expect(await executeProposal(p.id, { actor: actor.label })).toMatchObject({ status: 'blocked', reason: 'this store is not enabled for changes yet (beta access)' })

    const { code, invite } = await admin(db => createInvite(db, { label: 'Northwind beta', shopDomain: NW.domain }, 'staff:test'))
    expect(code).toMatch(/^DPL-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/)
    // only the hash is stored
    const stored = await admin(db => db.one<Record<string, unknown>>('select * from beta_invites where id = $1', [invite.id]))
    expect(JSON.stringify(stored)).not.toContain(code)
    expect(stored!.code_hash).toBe(hashCode(code))

    const state = await admin(db => redeemInvite(db, conn, code.toLowerCase().replace(/-/g, ' '), actor.label))
    expect(state).toMatchObject({ ok: true, access: { eligible: true, basis: 'beta_invite' } })
    await runScan(NW.conn, { trigger: 'test' })
    p = (await proposalFor(V(2003)))!
    await approveProposal(actor, p.id, p.change_hash)
    expect(await executeProposal(p.id, { actor: actor.label })).toMatchObject({ status: 'verified' })

    // the incident switch pauses writes even for an enabled store
    process.env.LIVE_WRITES = 'off'
    await runScan(NW.conn, { trigger: 'test' })
    p = (await proposalFor(V(2011)))!
    await approveProposal(actor, p.id, p.change_hash)
    expect(await executeProposal(p.id, { actor: actor.label })).toMatchObject({ status: 'blocked', reason: 'writes to live stores are paused by Deploi (LIVE_WRITES=off)' })
  })

  it('invite codes: bound to one shop, single use, revocable, and failed attempts are limited', async () => {
    const nw = await asRealStore()
    await admin(db => db.query('update store_connections set is_synthetic = false where id = $1', [HB.conn]))
    const hb = (await admin(db => loadConnection(db, HB.conn)))!
    const bound = await admin(db => createInvite(db, { label: 'Harbor only', shopDomain: HB.domain }, 'staff:test'))
    expect(await admin(db => redeemInvite(db, nw, bound.code, 'test'))).toEqual({ ok: false, error: 'that invite code is not valid for this store' })
    const single = await admin(db => createInvite(db, { label: 'One store' }, 'staff:test'))
    expect(await admin(db => redeemInvite(db, hb, single.code, 'test'))).toMatchObject({ ok: true, access: { eligible: true } })
    expect(await admin(db => redeemInvite(db, nw, single.code, 'test'))).toMatchObject({ ok: false })
    const revoked = await admin(db => createInvite(db, { label: 'Revoked' }, 'staff:test'))
    await admin(db => revokeInvite(db, revoked.invite.id, 'staff:test'))
    expect(await admin(db => redeemInvite(db, nw, revoked.code, 'test'))).toMatchObject({ ok: false })
    expect(await admin(db => getAccess(db, nw))).toMatchObject({ eligible: false })
    // 3 failures so far; 7 more reach the hourly limit, then even a valid code is refused
    for (let i = 0; i < 7; i++) expect(await admin(db => redeemInvite(db, nw, `DPL-WRONG-CODE${i}-XXXXX`, 'test'))).toMatchObject({ ok: false })
    const good = await admin(db => createInvite(db, { label: 'Valid' }, 'staff:test'))
    await expect(admin(db => redeemInvite(db, nw, good.code, 'test'))).rejects.toThrow('too many invite codes')
    const rowId = (await admin(db => loadAccessRow(db, 'shopify', NW.domain)))!.id
    const audit = await admin(db => db.query<{ detail: Record<string, unknown> }>(`select detail from engine_audit where entity_id = $1 and event = 'access.invite_failed'`, [rowId]))
    expect(audit.length).toBe(10)
    expect(JSON.stringify(audit)).not.toMatch(/DPL-/)
  })

  it('staff decisions: denial overrides a development store, approval enables a paid store, clearing restores the rules', async () => {
    const conn = await asRealStore()
    const row = await admin(db => recordShopFacts(db, conn, { isDevelopmentStore: true, planName: 'Developer Preview' }, 'test'))
    expect(row.status).toBe('eligible')
    await admin(db => decideAccess(db, row.id, 'denied', 'test denial', 'staff:test'))
    expect(await admin(db => getAccess(db, conn))).toMatchObject({ eligible: false, status: 'denied' })
    await admin(db => decideAccess(db, row.id, 'clear', '', 'staff:test'))
    expect(await admin(db => getAccess(db, conn))).toMatchObject({ eligible: true, basis: 'development_store' })
    await admin(db => recordShopFacts(db, conn, { isDevelopmentStore: false, planName: 'Basic' }, 'test'))
    expect(await admin(db => getAccess(db, conn))).toMatchObject({ eligible: false, status: 'pending' })
    await admin(db => decideAccess(db, row.id, 'approved', 'beta merchant', 'staff:test'))
    expect(await admin(db => getAccess(db, conn))).toMatchObject({ eligible: true, basis: 'staff_approved' })
  })

  it('open mode enables every installed store; real email follows the same access', async () => {
    const conn = await asRealStore()
    expect(await admin(db => emailBlockReason(db, NW.org))).toBe('this store is not enabled for real email yet (beta access)')
    process.env.STORE_ACCESS_MODE = 'open'
    expect(await admin(db => getAccess(db, conn))).toMatchObject({ eligible: true, basis: 'open_access', mode: 'open' })
    expect(await admin(db => emailBlockReason(db, NW.org))).toBeNull()
  })

  it('the access API is per store: another shop gets 404 for both reading and acting, and requests are recorded', async () => {
    await asRealStore()
    const other = await getAccessRoute(new Request(`http://localhost/api/store/access?connection=${NW.conn}`, { headers: bearer(HB.domain) }))
    expect(other.status).toBe(404)
    const own = await getAccessRoute(new Request(`http://localhost/api/store/access?connection=${NW.conn}`, { headers: bearer(NW.domain) }))
    expect(await own.json()).toMatchObject({ ok: true, access: { eligible: false, status: 'pending' } })
    const req = await postAccessRoute(new Request('http://localhost/api/store/access', { method: 'POST', headers: bearer(NW.domain), body: JSON.stringify({ connection: NW.conn, action: 'request', note: 'We sell candles' }) }))
    expect(await req.json()).toMatchObject({ ok: true, access: { requestedAt: expect.any(String) } })
    const cross = await postAccessRoute(new Request('http://localhost/api/store/access', { method: 'POST', headers: bearer(HB.domain), body: JSON.stringify({ connection: NW.conn, action: 'redeem', code: 'DPL-AAAAA-BBBBB-CCCCC' }) }))
    expect(cross.status).toBe(404)
    const conn = (await admin(db => loadConnection(db, NW.conn)))!
    expect(await admin(db => requestAccess(db, conn, 'x'.repeat(900), 'test')).then(() => admin(db => loadAccessRow(db, 'shopify', NW.domain)))).toMatchObject({ request_note: 'x'.repeat(500) })
  })
})
