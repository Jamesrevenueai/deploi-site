/**
 * Connecting Salesforce, Pipedrive, Zoho CRM and Buildium end to end against local Postgres, with every provider call
 * going through a fake HTTP layer: OAuth state and PKCE, encrypted tokens, the bound provider host, refresh before
 * expiry and on 401, disconnect (revoke + delete), tenant isolation, and the integration hub.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { completeOfficeConnect, connectBuildium, disconnectOffice, setOfficeExchanger, startOfficeConnect, type OfficeConnectionRow } from '../../lib/office/connections'
import { loadOfficeTokens, officeAccessToken, setOfficeRefresher } from '../../lib/office/credentials'
import { buildiumFor, crmFor, salesforceFor } from '../../lib/office/providers'
import { integrationDef, statusOf, testIntegration, disconnectIntegration, reconnectIntegration } from '../../lib/integrations/registry'
import { NW, HB, merchantActor, resetOffice } from '../office/helpers'
import { calls, fake, json, resetFake } from './fake-http'

const ready = await prepareDb()
const ENV = { SALESFORCE_CLIENT_ID: 'sf', SALESFORCE_CLIENT_SECRET: 'sf-secret', PIPEDRIVE_CLIENT_ID: 'pd', PIPEDRIVE_CLIENT_SECRET: 'pd-secret', ZOHO_CLIENT_ID: 'z', ZOHO_CLIENT_SECRET: 'z-secret' }
const clean = async () => {
  await resetOffice(NW); await resetOffice(HB)
  await admin(async db => { for (const t of ['connection_events', 'connection_sync_cursors', 'connection_health', 'connection_health_state']) await db.query(`delete from ${t} where org_id = any($1::uuid[])`, [[NW.org, HB.org]]) })
}
const SF_ID = 'https://login.salesforce.com/id/00D5g000004XyzAEAS/0055g00000AbCdEAAV'

describe.skipIf(!ready)('connections: Salesforce, Pipedrive, Zoho CRM, Buildium (local Postgres, fake provider HTTP)', () => {
  beforeEach(async () => { Object.assign(process.env, ENV); await clean() })
  afterEach(() => { resetFake(); setOfficeExchanger(null); setOfficeRefresher(null); for (const k of [...Object.keys(ENV), 'BUILDIUM_ENABLED']) delete process.env[k] })
  afterAll(async () => { if (ready) { await clean(); await resetOffice(NW, { enable: false }); await resetOffice(HB, { enable: false }) } })

  it('without client credentials the OAuth CRMs say "needs setup"; Buildium never uses a consent page', async () => {
    for (const k of Object.keys(ENV)) delete process.env[k]
    const nw = await merchantActor(NW)
    for (const p of ['salesforce', 'pipedrive', 'zoho_crm'] as const) await expect(startOfficeConnect(nw, p)).rejects.toMatchObject({ name: 'OfficeNotConfigured' })
    await expect(startOfficeConnect(nw, 'buildium')).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('Salesforce: PKCE verifier stored encrypted, S256 challenge in the consent URL, real exchange through the fake, tokens encrypted, instance bound', async () => {
    const nw = await merchantActor(NW)
    const s = await startOfficeConnect(nw, 'salesforce')
    const u = new URL(s.url)
    const st = await admin(db => db.one<{ verifier_ciphertext: string }>('select verifier_ciphertext from office_oauth_states where state = $1', [s.state]))
    expect(st!.verifier_ciphertext).toMatch(/^v1\./)
    let verifier = ''
    fake(c => {
      if (c.url.pathname === '/services/oauth2/token') { verifier = c.form!.get('code_verifier')!; return json(200, { access_token: 'SF-ACCESS-PLAINTEXT', refresh_token: 'SF-REFRESH-PLAINTEXT', instance_url: 'https://acme.my.salesforce.com', id: SF_ID, scope: 'api refresh_token' }) }
      return json(200, { records: [{ Name: 'Acme Inc' }] })
    })
    const conn = await completeOfficeConnect(nw, { provider: 'salesforce', state: s.state, code: 'sf-code', error: null })
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(u.searchParams.get('code_challenge'))
    expect(conn).toMatchObject({ provider: 'salesforce', external_account_id: '00D5g000004XyzAEAS', display_name: 'Acme Inc', api_base: 'https://acme.my.salesforce.com', status: 'active' })
    const raw = await admin(db => db.one<{ ciphertext: string; refresh_ciphertext: string }>('select ciphertext, refresh_ciphertext from office_credentials where connection_id = $1', [conn.id]))
    expect(raw!.ciphertext).not.toContain('SF-ACCESS'); expect(raw!.refresh_ciphertext).not.toContain('SF-REFRESH')
    expect((await admin(db => loadOfficeTokens(db, conn.id)))!).toMatchObject({ accessToken: 'SF-ACCESS-PLAINTEXT', refreshToken: 'SF-REFRESH-PLAINTEXT' })
    // single use
    await expect(completeOfficeConnect(nw, { provider: 'salesforce', state: s.state, code: 'sf-code', error: null })).rejects.toMatchObject({ code: 'expired' })
  })

  it('the state is bound to the organization, the user and the provider', async () => {
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    setOfficeExchanger(async () => ({ tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: 3600, scopes: [] }, externalId: '1', displayName: 'x', apiBase: 'https://acme.pipedrive.com' }))
    const a = await startOfficeConnect(nw, 'pipedrive')
    expect(new URL(a.url).searchParams.get('code_challenge')).toBeNull()
    await expect(completeOfficeConnect(hb, { provider: 'pipedrive', state: a.state, code: 'c', error: null })).rejects.toMatchObject({ code: 'forbidden' })
    const b = await startOfficeConnect(nw, 'pipedrive')
    await expect(completeOfficeConnect(nw, { provider: 'zoho_crm', state: b.state, code: 'c', error: null })).rejects.toMatchObject({ code: 'invalid_input' })
    const d = await startOfficeConnect(nw, 'zoho_crm')
    await expect(completeOfficeConnect(nw, { provider: 'zoho_crm', state: d.state, code: null, error: 'access_denied' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('Zoho: the accounts server from the callback is used for the exchange; an unknown one is refused before any call', async () => {
    const nw = await merchantActor(NW)
    fake(c => c.url.pathname === '/oauth/v2/token' ? json(200, { access_token: 'Z-AT', refresh_token: 'Z-RT', api_domain: 'https://www.zohoapis.eu', expires_in: 3600 }) : json(200, { org: [{ id: '20071234', company_name: 'Acme GmbH' }] }))
    const a = await startOfficeConnect(nw, 'zoho_crm')
    await expect(completeOfficeConnect(nw, { provider: 'zoho_crm', state: a.state, code: 'c', error: null, accountsServer: 'https://accounts.zoho.evil.example' })).rejects.toThrow(/does not know/)
    expect(calls).toHaveLength(0)
    const b = await startOfficeConnect(nw, 'zoho_crm')
    const conn = await completeOfficeConnect(nw, { provider: 'zoho_crm', state: b.state, code: 'c', error: null, accountsServer: 'https://accounts.zoho.eu' })
    expect(conn).toMatchObject({ external_account_id: '20071234', display_name: 'Acme GmbH', api_base: 'https://www.zohoapis.eu' })
    expect(calls[0].url.host).toBe('accounts.zoho.eu')
    expect(calls[1].url.host).toBe('www.zohoapis.eu')
  })

  async function connected(provider: 'salesforce' | 'pipedrive' | 'zoho_crm', apiBase: string, expiresIn = 3600) {
    const nw = await merchantActor(NW)
    setOfficeExchanger(async () => ({ tokens: { accessToken: `${provider}-at-1`, refreshToken: `${provider}-rt-1`, expiresIn, scopes: ['x'] }, externalId: `${provider}-acct`, displayName: provider, apiBase }))
    const a = await startOfficeConnect(nw, provider)
    return completeOfficeConnect(nw, { provider, state: a.state, code: 'c', error: null })
  }

  it('refresh before expiry: the refresher gets the bound host, a moved Salesforce instance is stored', async () => {
    const conn = await connected('salesforce', 'https://acme.my.salesforce.com', 60) // expires inside the refresh skew
    const seen: unknown[] = []
    setOfficeRefresher(async (p, rt, scopes, ctx) => { seen.push({ p, rt, ctx }); return { accessToken: 'salesforce-at-2', refreshToken: null, expiresIn: 7200, scopes, apiBase: 'https://acme2.my.salesforce.com' } })
    expect(await officeAccessToken(conn.id)).toBe('salesforce-at-2')
    expect(seen).toEqual([{ p: 'salesforce', rt: 'salesforce-rt-1', ctx: { apiBase: 'https://acme.my.salesforce.com' } }])
    const row = await admin(db => db.one<OfficeConnectionRow>('select * from office_connections where id = $1', [conn.id]))
    expect(row!.api_base).toBe('https://acme2.my.salesforce.com')
    expect((await admin(db => loadOfficeTokens(db, conn.id)))!.refreshToken).toBe('salesforce-rt-1') // not rotated: the old one is kept
  })

  it('refresh on 401: the client asks for a new token once and repeats the call; a refused refresh needs reconnecting', async () => {
    const conn = await connected('salesforce', 'https://acme.my.salesforce.com')
    let refreshes = 0
    setOfficeRefresher(async (_p, _rt, scopes) => { refreshes++; return { accessToken: 'salesforce-at-2', refreshToken: null, expiresIn: 7200, scopes } })
    fake(c => c.headers.get('authorization') === 'Bearer salesforce-at-1' ? json(401, [{ errorCode: 'INVALID_SESSION_ID' }]) : json(200, { records: [{ Name: 'Acme' }] }))
    const row = (await admin(db => db.one<OfficeConnectionRow>('select * from office_connections where id = $1', [conn.id])))!
    expect(await salesforceFor(row).identity()).toEqual({ orgName: 'Acme' })
    expect(refreshes).toBe(1)
    expect(calls.map(c => c.headers.get('authorization'))).toEqual(['Bearer salesforce-at-1', 'Bearer salesforce-at-2'])
    // the provider refuses the refresh token: the connection is marked for reconnection and the call fails cleanly
    setOfficeRefresher(async () => { throw Object.assign(new Error('refused'), { auth: true }) })
    fake(() => json(401, [{ errorCode: 'INVALID_SESSION_ID' }]))
    await expect(crmFor(row).findContactByEmail('a@b.co')).rejects.toMatchObject({ name: 'OfficeAuthError' })
    expect((await admin(db => db.one<{ status: string }>('select status from office_connections where id = $1', [conn.id])))!.status).toBe('needs_reauth')
    expect((await admin(db => statusOf(db, integrationDef('salesforce'), NW.org))).status).toBe('needs_reauth')
  })

  it('disconnect revokes at the provider, deletes the tokens and keeps the other organization untouched', async () => {
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    const sf = await connected('salesforce', 'https://acme.my.salesforce.com')
    const pd = await connected('pipedrive', 'https://acme.pipedrive.com')
    const z = await connected('zoho_crm', 'https://www.zohoapis.com.au')
    fake(() => new Response('{}', { status: 200 }))
    await expect(disconnectOffice(hb, sf.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(calls).toHaveLength(0) // nothing revoked for someone else's request
    for (const c of [sf, pd, z]) {
      const r = await disconnectOffice(nw, c.id)
      expect(r).toMatchObject({ credentialDeleted: true, revokedAtProvider: true })
      expect(await admin(db => db.one('select 1 from office_credentials where connection_id = $1', [c.id]))).toBeNull()
    }
    expect(calls.map(c => `${c.method} ${c.url.origin}${c.url.pathname}`)).toEqual([
      'POST https://login.salesforce.com/services/oauth2/revoke', 'POST https://oauth.pipedrive.com/oauth/revoke', 'POST https://accounts.zoho.com.au/oauth/v2/token/revoke'])
    expect(calls[0].form!.get('token')).toBe('salesforce-rt-1')
    expect(calls[2].url.searchParams.get('token')).toBe('zoho_crm-rt-1')
  })

  it('Buildium: the key is checked with one read, stored encrypted, never revoked remotely; a refused key stores nothing', async () => {
    const nw = await merchantActor(NW)
    fake(c => c.headers.get('x-buildium-client-secret') === 'good-secret-123' ? json(200, { AccountId: 5150, CompanyName: 'Harbor PM' }) : json(401, { UserMessage: 'Unauthorized' }))
    await expect(connectBuildium(nw, { clientId: 'client-id-12345', clientSecret: 'bad-secret-123' })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/did not accept/) })
    expect(await admin(db => db.one(`select 1 from office_connections where org_id = $1 and provider = 'buildium'`, [NW.org]))).toBeNull()
    await expect(connectBuildium(nw, { clientId: 'x', clientSecret: 'y' })).rejects.toMatchObject({ code: 'invalid_input' })
    const conn = await connectBuildium(nw, { clientId: 'client-id-12345', clientSecret: 'good-secret-123' })
    expect(conn).toMatchObject({ provider: 'buildium', external_account_id: '5150', display_name: 'Harbor PM', api_base: 'https://api.buildium.com' })
    const raw = await admin(db => db.one<{ ciphertext: string; refresh_ciphertext: string | null }>('select ciphertext, refresh_ciphertext from office_credentials where connection_id = $1', [conn.id]))
    expect(raw!.ciphertext).not.toContain('good-secret'); expect(raw!.refresh_ciphertext).toBeNull()
    calls.length = 0
    expect(await buildiumFor(conn).listWorkOrders()).toEqual([])
    expect(calls[0].headers.get('x-buildium-client-id')).toBe('client-id-12345')
    // the hub probe reads the account and checks it is the same one
    const t = await testIntegration(NW.org, 'buildium')
    expect(t.results[0]).toMatchObject({ ok: true })
    expect(t.message).toMatch(/Harbor PM/)
    calls.length = 0
    const r = await disconnectIntegration(nw, 'buildium', conn.id)
    expect(r.message).toMatch(/disconnected/)
    expect(calls).toHaveLength(0)
    expect(await admin(db => db.one('select 1 from office_credentials where connection_id = $1', [conn.id]))).toBeNull()
    process.env.BUILDIUM_ENABLED = 'off'
    await expect(connectBuildium(nw, { clientId: 'client-id-12345', clientSecret: 'good-secret-123' })).rejects.toMatchObject({ name: 'OfficeNotConfigured' })
  })

  it('the integration hub: status, a read-only probe, identity checks, reconnect and isolation for the CRMs', async () => {
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    const pd = await connected('pipedrive', 'https://acme.pipedrive.com')
    expect(await admin(db => statusOf(db, integrationDef('pipedrive'), NW.org))).toMatchObject({ status: 'connected', can: { disconnect: true, test: true, synthetic: false } })
    expect((await admin(db => statusOf(db, integrationDef('pipedrive'), HB.org))).connections).toEqual([])
    // the token now belongs to a different Pipedrive company: an identity change, reported, nothing written
    fake(() => json(200, { success: true, data: { id: 1, company_id: 999, company_name: 'Other Co' } }))
    const t = await testIntegration(NW.org, 'pipedrive')
    expect(t.results[0]).toMatchObject({ ok: false, code: 'identity_changed' })
    expect(calls.every(c => c.method === 'GET')).toBe(true)
    await expect(reconnectIntegration(hb, 'pipedrive', pd.id)).rejects.toMatchObject({ code: 'not_found' })
    const r = await reconnectIntegration(nw, 'pipedrive', pd.id)
    expect(r).toMatchObject({ kind: 'redirect' })
    expect((r as { url: string }).url).toMatch(/^https:\/\/oauth\.pipedrive\.com\/oauth\/authorize\?/)
  })
})
