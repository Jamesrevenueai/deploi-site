/**
 * Connecting a WooCommerce store: the one-time, expiring, organization-bound authorization state; the
 * callback that receives the key pair; manual keys validated by a live read; encrypted storage;
 * refusal across organizations; disconnect; and organization isolation. The store is a fake HTTP
 * layer: nothing leaves the machine.
 */
import './helpers'
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest'
import { prepareDb, SESSIONS } from '../db/helpers'
import { admin, withUser } from '../../lib/db'
import { loadCredential, decryptSecret } from '../../lib/connectors/credentials'
import { startAuthorization, receiveCallback, finalizeAuthorization, parseStateToken, purgeStaleStates } from '../../lib/connectors/woocommerce/auth'
import { connectStore, disconnectStore } from '../../lib/connectors/woocommerce/connect'
import { wooStatusFor } from '../../lib/connectors/woocommerce/status'
import { decodeCreds } from '../../lib/connectors/woocommerce/client'
import { fakeWooTransport, type WooSynthState } from '../../lib/connectors/woocommerce/synthetic'
import { wooDemoState } from '../../lib/connectors/woocommerce/demo-store'
import { createAgent, grantPolicy } from '../../lib/agents/lifecycle'
import { merchantActor, NW, HB } from '../merchant/helpers'
import { clearConnection } from './helpers'

const ready = await prepareDb()
const SITE = 'https://woo-connect-test-shop.com'
const CK = 'ck_' + '1'.repeat(40), CS = 'cs_' + '2'.repeat(40)
const CREDS = { consumerKey: CK, consumerSecret: CS }
let store: WooSynthState
const deps = () => ({ transport: fakeWooTransport(store) })
const prevAppUrl = process.env.NEXT_PUBLIC_APP_URL

async function wipe() {
  const ids = await admin(db => db.query<{ id: string }>(`select id from store_connections where platform = 'woocommerce' and external_id like 'https://woo-connect-test-%'`))
  for (const { id } of ids) await clearConnection(id)
  await admin(async db => {
    await db.query(`delete from store_connections where platform = 'woocommerce' and external_id like 'https://woo-connect-test-%'`)
    await db.query(`delete from woo_auth_states where site_url like 'https://woo-connect-test-%'`)
  })
}
const callbackBody = (token: string, over: Record<string, unknown> = {}) => ({ key_id: 41, user_id: token, consumer_key: CK, consumer_secret: CS, key_permissions: 'read_write', ...over })
const conn = () => admin(db => db.one<{ id: string; org_id: string; status: string; scopes: string[]; currency: string | null; api_version: string }>(`select id, org_id, status, scopes, currency, api_version from store_connections where platform = 'woocommerce' and external_id = $1`, [SITE]))

beforeAll(() => { process.env.NEXT_PUBLIC_APP_URL = 'https://app.deploi-test.com' })
beforeEach(async () => {
  store = wooDemoState({ siteUrl: SITE, keys: [{ consumerKey: CK, consumerSecret: CS, permissions: 'read_write' }] })
  if (ready) await wipe()
})
afterAll(async () => { process.env.NEXT_PUBLIC_APP_URL = prevAppUrl; if (ready) await wipe() })

describe.skipIf(!ready)('authorization flow (/wc-auth/v1/authorize)', () => {
  it('sends the merchant to WooCommerce with read_write, a signed one-time state, and https return and callback URLs', async () => {
    const actor = await merchantActor(NW)
    const s = await startAuthorization({ orgId: NW.org, actor: actor.label, profileId: null, siteUrl: 'woo-connect-test-shop.com/' })
    const u = new URL(s.authorizeUrl)
    expect(`${u.origin}${u.pathname}`).toBe(`${SITE}/wc-auth/v1/authorize`)
    expect(Object.fromEntries(u.searchParams)).toEqual({ app_name: 'Deploi', scope: 'read_write', user_id: s.token, return_url: 'https://app.deploi-test.com/api/woocommerce/return', callback_url: 'https://app.deploi-test.com/api/woocommerce/callback' })
    expect(parseStateToken(s.token)?.id).toBe(s.stateId)
    await expect(startAuthorization({ orgId: NW.org, actor: actor.label, profileId: null, siteUrl: 'http://woo-connect-test-shop.com' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(startAuthorization({ orgId: NW.org, actor: actor.label, profileId: null, siteUrl: 'https://10.0.0.1' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('the callback accepts the keys once, stores them encrypted, and finalize connects with a live read', async () => {
    const s = await startAuthorization({ orgId: NW.org, actor: 'user:test', profileId: null, siteUrl: SITE })
    const r = await receiveCallback(callbackBody(s.token))
    expect(r).toMatchObject({ status: 200, stateId: s.stateId })
    const held = await admin(db => db.one<{ keys_ciphertext: string; status: string }>('select keys_ciphertext, status from woo_auth_states where id = $1', [s.stateId]))
    expect(held!.status).toBe('received')
    expect(held!.keys_ciphertext).not.toContain('ck_')
    // a replay of the same callback is refused (WooCommerce would then delete that key)
    expect((await receiveCallback(callbackBody(s.token))).status).toBe(400)

    const f = await finalizeAuthorization(s.stateId, deps())
    expect(f).toMatchObject({ status: 'connected', orgId: NW.org })
    const c = (await conn())!
    expect(c).toMatchObject({ org_id: NW.org, status: 'active', scopes: ['read', 'write'], currency: 'USD', api_version: 'wc/v3' })
    // the key pair is stored encrypted as an api_key_pair; the state no longer holds it
    const raw = await admin(db => db.one<{ token_kind: string; ciphertext: string; key_id: string }>('select token_kind, ciphertext, key_id from store_credentials where connection_id = $1', [c.id]))
    expect(raw!.token_kind).toBe('api_key_pair')
    expect(raw!.ciphertext).not.toContain(CK)
    expect(raw!.ciphertext).not.toContain(CS)
    expect(decodeCreds((await admin(db => loadCredential(db, c.id)))!.secret)).toEqual(CREDS)
    expect(() => decryptSecret(raw!.key_id, raw!.ciphertext, NW.conn)).toThrow() // bound to its own connection
    expect((await admin(db => db.one<{ keys_ciphertext: string | null; status: string }>('select keys_ciphertext, status from woo_auth_states where id = $1', [s.stateId])))).toEqual({ keys_ciphertext: null, status: 'connected' })
    // webhooks registered with a per-connection secret, delivered to a URL naming the connection
    expect(store.webhooks.map(w => w.topic).sort()).toEqual(['order.created', 'product.deleted', 'product.updated'])
    expect(store.webhooks.every(w => w.delivery_url === `https://app.deploi-test.com/api/woocommerce/webhooks?c=${c.id}` && w.secret.length >= 40)).toBe(true)
    expect(new Set(store.webhooks.map(w => w.secret)).size).toBe(1)
    // finalize is idempotent
    expect(await finalizeAuthorization(s.stateId, deps())).toMatchObject({ status: 'connected', connectionId: c.id })
    // no audit row carries key material
    const audits = await admin(db => db.query<{ detail: unknown }>('select detail from engine_audit where connection_id = $1 or detail::text like $2', [c.id, `%${s.stateId}%`]))
    expect(JSON.stringify(audits)).not.toContain(CK)
    expect(JSON.stringify(audits)).not.toContain(CS)
  })

  it('refuses expired, tampered, unknown and read-only callbacks', async () => {
    const past = new Date(Date.now() - 31 * 60e3)
    const old = await startAuthorization({ orgId: NW.org, actor: 'user:test', profileId: null, siteUrl: SITE }, past)
    expect(await receiveCallback(callbackBody(old.token))).toMatchObject({ status: 400, reason: expect.stringMatching(/expired/) })
    const s = await startAuthorization({ orgId: NW.org, actor: 'user:test', profileId: null, siteUrl: SITE })
    const tampered = s.token.slice(0, -2) + (s.token.endsWith('AA') ? 'BB' : 'AA')
    expect((await receiveCallback(callbackBody(tampered))).status).toBe(400)
    expect((await receiveCallback(callbackBody('00000000-0000-0000-0000-000000000000.' + 'A'.repeat(43)))).status).toBe(400)
    expect((await receiveCallback({})).status).toBe(400)
    expect(await receiveCallback(callbackBody(s.token, { key_permissions: 'read' }))).toMatchObject({ status: 400, reason: expect.stringMatching(/Read\/Write/) })
    // once refused, the state cannot be used again
    expect((await receiveCallback(callbackBody(s.token))).status).toBe(400)
    const s2 = await startAuthorization({ orgId: NW.org, actor: 'user:test', profileId: null, siteUrl: SITE })
    expect((await receiveCallback(callbackBody(s2.token, { consumer_key: 'ck_bad' }))).status).toBe(400)
    expect(await conn()).toBeNull()
  })

  it('a state is bound to its organization: a store connected to one organization is refused for another', async () => {
    await connectStore({ orgId: NW.org, actor: 'user:nw', siteUrl: SITE, creds: CREDS, permissions: 'read_write', via: 'manual' }, deps())
    await expect(startAuthorization({ orgId: HB.org, actor: 'user:hb', profileId: null, siteUrl: SITE })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(connectStore({ orgId: HB.org, actor: 'user:hb', siteUrl: SITE, creds: CREDS, permissions: 'read_write', via: 'manual' }, deps())).rejects.toMatchObject({ code: 'forbidden' })
    expect((await conn())!.org_id).toBe(NW.org)
    // a state started by Harbor before Northwind connected the store cannot take it over
    await disconnectStore(NW.org, (await conn())!.id, 'user:nw', deps())
    await admin(db => db.query(`delete from store_connections where external_id = $1`, [SITE]))
    const hb = await startAuthorization({ orgId: HB.org, actor: 'user:hb', profileId: null, siteUrl: SITE })
    await receiveCallback(callbackBody(hb.token))
    await connectStore({ orgId: NW.org, actor: 'user:nw', siteUrl: SITE, creds: CREDS, permissions: 'read_write', via: 'manual' }, deps())
    expect(await finalizeAuthorization(hb.stateId, deps())).toMatchObject({ status: 'failed', reason: expect.stringMatching(/another Deploi account/) })
    expect((await conn())!.org_id).toBe(NW.org)
  })

  it('stale states lose their key material', async () => {
    const s = await startAuthorization({ orgId: NW.org, actor: 'user:test', profileId: null, siteUrl: SITE }, new Date(Date.now() - 20 * 60e3))
    await receiveCallback(callbackBody(s.token))
    expect(await purgeStaleStates(new Date(Date.now() + 60 * 60e3))).toBeGreaterThanOrEqual(1)
    expect(await admin(db => db.one('select status, keys_ciphertext from woo_auth_states where id = $1', [s.stateId]))).toEqual({ status: 'failed', keys_ciphertext: null })
  })
})

describe.skipIf(!ready)('manual keys, disconnect and isolation', () => {
  it('manual keys are validated by a live read before anything is stored', async () => {
    await expect(connectStore({ orgId: NW.org, actor: 'user:nw', siteUrl: SITE, creds: { consumerKey: 'ck_' + '9'.repeat(40), consumerSecret: CS }, permissions: 'read_write', via: 'manual' }, deps())).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(connectStore({ orgId: NW.org, actor: 'user:nw', siteUrl: SITE, creds: { consumerKey: 'nope', consumerSecret: CS }, permissions: 'read_write', via: 'manual' }, deps())).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(connectStore({ orgId: NW.org, actor: 'user:nw', siteUrl: 'http://woo-connect-test-shop.com', creds: CREDS, permissions: 'read_write', via: 'manual' }, deps())).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await conn()).toBeNull()
    const r = await connectStore({ orgId: NW.org, actor: 'user:nw', siteUrl: SITE, creds: CREDS, permissions: 'read_write', via: 'manual' }, deps())
    expect(r.created).toBe(true)
    const status = await wooStatusFor(NW.org)
    const view = status.connections.find(c => c.id === r.connectionId)!
    expect(view).toMatchObject({ site_url: SITE, connected_via: 'manual', wc_version: '11.2.1', webhooks: 3, has_credential: true })
    expect(JSON.stringify(status)).not.toContain(CK)
  })

  it('disconnect deletes the webhooks and the key, and stops agents on the store', async () => {
    const actor = await merchantActor(NW)
    const r = await connectStore({ orgId: NW.org, actor: actor.label, siteUrl: SITE, creds: CREDS, permissions: 'read_write', via: 'manual' }, deps())
    const a = await createAgent(actor, { name: 'Woo to stop', taskText: '', policy: { connectionId: r.connectionId, productScope: { mode: 'all' }, correctionTypes: ['oversell_policy'], approvalMode: 'review' } })
    await grantPolicy(actor, a.agentId, a.policyId, a.policyHash)
    await expect(disconnectStore(HB.org, r.connectionId, 'user:hb', deps())).rejects.toMatchObject({ code: 'not_found' })
    const d = await disconnectStore(NW.org, r.connectionId, actor.label, deps())
    expect(d.webhooksDeleted).toBe(3)
    expect(store.webhooks).toHaveLength(0)
    expect(await admin(db => loadCredential(db, r.connectionId))).toBeNull()
    expect((await conn())!.status).toBe('disconnected')
    expect((await admin(db => db.one<{ status: string }>('select status from agents where id = $1', [a.agentId])))!.status).toBe('paused')
    // reconnecting the same store later reactivates the same connection
    const again = await connectStore({ orgId: NW.org, actor: actor.label, siteUrl: SITE, creds: CREDS, permissions: 'read_write', via: 'manual' }, deps())
    expect(again).toMatchObject({ connectionId: r.connectionId, created: false })
  })

  it('another organization cannot see the connection; key and state tables are unreadable from any user session', async () => {
    const r = await connectStore({ orgId: NW.org, actor: 'user:nw', siteUrl: SITE, creds: CREDS, permissions: 'read_write', via: 'manual' }, deps())
    const theirs = await withUser(SESSIONS.harbor, db => db.query(`select id from store_connections where id = $1`, [r.connectionId]))
    expect(theirs).toEqual([])
    const mine = await withUser(SESSIONS.northwind, db => db.query(`select id from store_connections where id = $1`, [r.connectionId]))
    expect(mine).toHaveLength(1)
    for (const t of ['store_credentials', 'woo_connections', 'woo_auth_states'])
      await expect(withUser(SESSIONS.northwind, db => db.query(`select * from ${t} limit 1`)), t).rejects.toThrow(/permission denied/)
    expect((await wooStatusFor(HB.org)).connections.map(c => c.id)).not.toContain(r.connectionId)
  })
})
