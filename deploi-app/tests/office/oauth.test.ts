import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { startOfficeConnect, completeOfficeConnect, setOfficeExchanger, disconnectOffice, OfficeNotConfigured } from '../../lib/office/connections'
import { loadOfficeTokens, officeAccessToken, setOfficeRefresher, OfficeAuthError } from '../../lib/office/credentials'
import { HUBSPOT_SCOPES } from '../../lib/office/hubspot'
import { CAL_EVENTS, CAL_FREEBUSY } from '../../lib/office/calendar'
import { staffActor } from '../merchant/helpers'
import { setOfficeFetch } from '../../lib/office/http'
import { NW, HB, merchantActor, resetOffice } from './helpers'

const ready = await prepareDb()
// leave no Office agents, actions or connections behind for other test files
afterAll(async () => { if (ready) { await resetOffice(NW, { enable: false }); await resetOffice(HB, { enable: false }) } })
const ENV = ['HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET', 'GOOGLE_CALENDAR_CLIENT_ID', 'GOOGLE_CALENDAR_CLIENT_SECRET']
const seen: { provider: string; code: string; verifier: string | null }[] = []
const configure = () => { for (const k of ENV) process.env[k] = `test-${k.toLowerCase()}` }

describe.skipIf(!ready)('office connections: OAuth state, PKCE, encrypted tokens, refresh, disconnect', () => {
  beforeEach(async () => {
    await resetOffice(NW); await resetOffice(HB)
    seen.length = 0
    setOfficeExchanger(async (provider, code, verifier) => {
      seen.push({ provider, code, verifier })
      return provider === 'hubspot'
        ? { tokens: { accessToken: 'hs-access-PLAINTEXT', refreshToken: 'hs-refresh-PLAINTEXT', expiresIn: 1800, scopes: [...HUBSPOT_SCOPES] }, externalId: '4711', displayName: 'Portal 4711' }
        : { tokens: { accessToken: 'g-access', refreshToken: 'g-refresh', expiresIn: 3600, scopes: ['openid', 'email', CAL_EVENTS, CAL_FREEBUSY] }, externalId: 'owner@northwind.example', displayName: 'owner@northwind.example' }
    })
  })
  afterEach(() => { for (const k of ENV) delete process.env[k]; setOfficeExchanger(null); setOfficeRefresher(null) })

  it('without client credentials connecting is refused as "needs setup"', async () => {
    const actor = await merchantActor(NW)
    await expect(startOfficeConnect(actor, 'hubspot')).rejects.toBeInstanceOf(OfficeNotConfigured)
    await expect(startOfficeConnect(actor, 'google_calendar')).rejects.toBeInstanceOf(OfficeNotConfigured)
  })

  it('the state is single-use, bound to the organization and user, and expires', async () => {
    configure()
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    const a = await startOfficeConnect(nw, 'hubspot')
    expect(new URL(a.url).searchParams.get('code_challenge')).toBeNull() // HubSpot takes no PKCE parameters
    // another organization cannot use it (and the attempt burns it)
    await expect(completeOfficeConnect(hb, { provider: 'hubspot', state: a.state, code: 'c1', error: null })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(completeOfficeConnect(nw, { provider: 'hubspot', state: a.state, code: 'c1', error: null })).rejects.toMatchObject({ code: 'expired' })
    const b = await startOfficeConnect(nw, 'hubspot')
    const conn = await completeOfficeConnect(nw, { provider: 'hubspot', state: b.state, code: 'c2', error: null })
    expect(conn).toMatchObject({ provider: 'hubspot', external_account_id: '4711', is_synthetic: false, status: 'active' })
    await expect(completeOfficeConnect(nw, { provider: 'hubspot', state: b.state, code: 'c2', error: null })).rejects.toMatchObject({ code: 'expired' })
    // expired after ten minutes
    const old = await startOfficeConnect(nw, 'google_calendar', { now: new Date(Date.now() - 11 * 60e3) })
    await expect(completeOfficeConnect(nw, { provider: 'google_calendar', state: old.state, code: 'c3', error: null })).rejects.toMatchObject({ code: 'expired' })
    // a denied consent connects nothing
    const d = await startOfficeConnect(nw, 'google_calendar')
    await expect(completeOfficeConnect(nw, { provider: 'google_calendar', state: d.state, code: null, error: 'access_denied' })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(seen.map(x => x.code)).toEqual(['c2'])
    await expect(startOfficeConnect(await staffActor(), 'hubspot')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('Google uses PKCE: the verifier handed to the token exchange matches the S256 challenge in the consent URL', async () => {
    configure()
    const nw = await merchantActor(NW)
    const g = await startOfficeConnect(nw, 'google_calendar')
    const challenge = new URL(g.url).searchParams.get('code_challenge')!
    expect(new URL(g.url).searchParams.get('code_challenge_method')).toBe('S256')
    const stored = await admin(db => db.one<{ verifier_ciphertext: string }>('select verifier_ciphertext from office_oauth_states where state = $1', [g.state]))
    expect(stored!.verifier_ciphertext).toMatch(/^v1\./)
    await completeOfficeConnect(nw, { provider: 'google_calendar', state: g.state, code: 'gc', error: null })
    expect(createHash('sha256').update(seen[0].verifier!).digest('base64url')).toBe(challenge)
  })

  it('refuses a grant without the needed scopes', async () => {
    configure()
    const nw = await merchantActor(NW)
    setOfficeExchanger(async () => ({ tokens: { accessToken: 'x', refreshToken: 'y', expiresIn: 60, scopes: ['crm.objects.contacts.read'] }, externalId: '1', displayName: null }))
    const a = await startOfficeConnect(nw, 'hubspot')
    await expect(completeOfficeConnect(nw, { provider: 'hubspot', state: a.state, code: 'c', error: null })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('tokens are encrypted at rest and bound to their connection; refreshed shortly before expiry; a dead refresh marks the connection', async () => {
    configure()
    const nw = await merchantActor(NW)
    const a = await startOfficeConnect(nw, 'hubspot')
    const conn = await completeOfficeConnect(nw, { provider: 'hubspot', state: a.state, code: 'c', error: null })
    const raw = await admin(db => db.one<{ ciphertext: string; refresh_ciphertext: string }>('select ciphertext, refresh_ciphertext from office_credentials where connection_id = $1', [conn.id]))
    expect(JSON.stringify(raw)).not.toMatch(/PLAINTEXT/)
    expect(await officeAccessToken(conn.id)).toBe('hs-access-PLAINTEXT')
    // a ciphertext copied onto another connection does not decrypt (the connection id is authenticated data)
    const other = await admin(db => db.one<{ id: string }>(`insert into office_connections (org_id, provider, external_account_id, connected_by, status) values ($1,'google_calendar','x@y.example','test','active') returning id`, [NW.org]))
    await admin(db => db.query(`insert into office_credentials (connection_id, org_id, key_id, ciphertext) select $2, org_id, key_id, ciphertext from office_credentials where connection_id = $1`, [conn.id, other!.id]))
    await expect(admin(db => loadOfficeTokens(db, other!.id))).rejects.toThrow()
    // near expiry: refreshed once, the new token stored encrypted
    let refreshed = 0
    setOfficeRefresher(async (_p, rt) => { refreshed++; expect(rt).toBe('hs-refresh-PLAINTEXT'); return { accessToken: 'hs-access-2', refreshToken: null, expiresIn: 1800, scopes: [] } })
    await admin(db => db.query(`update office_credentials set expires_at = now() + interval '1 minute' where connection_id = $1`, [conn.id]))
    expect(await officeAccessToken(conn.id)).toBe('hs-access-2')
    expect(await officeAccessToken(conn.id)).toBe('hs-access-2')
    expect(refreshed).toBe(1)
    expect((await admin(db => loadOfficeTokens(db, conn.id)))!.refreshToken).toBe('hs-refresh-PLAINTEXT') // kept when not rotated
    // the provider no longer accepts the refresh token: the connection needs reconnecting
    setOfficeRefresher(async () => { throw Object.assign(new Error('BAD_REFRESH_TOKEN'), { auth: true }) })
    await admin(db => db.query(`update office_credentials set expires_at = now() where connection_id = $1`, [conn.id]))
    await expect(officeAccessToken(conn.id)).rejects.toBeInstanceOf(OfficeAuthError)
    expect((await admin(db => db.one<{ status: string }>('select status from office_connections where id = $1', [conn.id])))!.status).toBe('needs_reauth')
  })

  it('disconnect deletes the credential and cancels queued work that needs the connection', async () => {
    configure()
    const nw = await merchantActor(NW)
    const a = await startOfficeConnect(nw, 'hubspot')
    const conn = await completeOfficeConnect(nw, { provider: 'hubspot', state: a.state, code: 'c', error: null })
    await expect(disconnectOffice(await merchantActor(HB), conn.id)).rejects.toMatchObject({ code: 'not_found' })
    // HubSpot is asked to revoke the refresh token (fake HTTP: no real call is made)
    const calls: { url: string; method: string }[] = []
    setOfficeFetch(async (url, init) => { calls.push({ url, method: String(init.method) }); return new Response(null, { status: 204 }) })
    const r = await disconnectOffice(nw, conn.id).finally(() => setOfficeFetch(null))
    expect(calls).toEqual([{ url: 'https://api.hubapi.com/oauth/v1/refresh-tokens/hs-refresh-PLAINTEXT', method: 'DELETE' }])
    expect(r).toMatchObject({ credentialDeleted: true, revokedAtProvider: true })
    expect(await admin(db => db.one('select 1 from office_credentials where connection_id = $1', [conn.id]))).toBeNull()
    await expect(officeAccessToken(conn.id)).rejects.toBeInstanceOf(OfficeAuthError)
  })
})
