import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { pipedriveAuthorizeUrl, pipedriveClient, pipedriveDomain, pipedriveExchange, pipedriveRefresh, pipedriveRevoke } from '../../lib/office/pipedrive'
import { calls, fake, json, path, resetFake, tokens, waits } from './fake-http'

const ENV = { PIPEDRIVE_CLIENT_ID: 'pd-client', PIPEDRIVE_CLIENT_SECRET: 'pd-secret', APP_URL: 'https://app.getdeploi.com' }
const DOMAIN = 'https://acme.pipedrive.com'
const basic = `Basic ${Buffer.from('pd-client:pd-secret').toString('base64')}`

describe('Pipedrive (fake HTTP; no real call is made)', () => {
  beforeEach(() => { Object.assign(process.env, ENV) })
  afterEach(() => { resetFake(); for (const k of Object.keys(ENV)) delete process.env[k] })

  it('consent URL carries the client id, redirect and state (scopes are set on the app)', () => {
    const u = new URL(pipedriveAuthorizeUrl('st'))
    expect(`${u.origin}${u.pathname}`).toBe('https://oauth.pipedrive.com/oauth/authorize')
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: 'pd-client', redirect_uri: 'https://app.getdeploi.com/api/office/oauth/pipedrive/callback', state: 'st' })
  })

  it('exchange and refresh use HTTP Basic client credentials; the company api_domain is bound and checked', async () => {
    fake(() => json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3599, scope: 'base,deals:full,contacts:full', api_domain: DOMAIN }))
    expect(await pipedriveExchange('code-1')).toMatchObject({ accessToken: 'AT', refreshToken: 'RT', expiresIn: 3599, apiDomain: DOMAIN, scopes: ['base', 'deals:full', 'contacts:full'] })
    expect(calls[0].headers.get('authorization')).toBe(basic)
    expect(Object.fromEntries(calls[0].form!)).toEqual({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://app.getdeploi.com/api/office/oauth/pipedrive/callback' })
    calls.length = 0
    fake(() => json(200, { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3599, api_domain: DOMAIN }))
    expect(await pipedriveRefresh('RT', [])).toMatchObject({ accessToken: 'AT2', refreshToken: 'RT2', apiBase: DOMAIN }) // a rotated refresh token is kept
    expect(Object.fromEntries(calls[0].form!)).toEqual({ grant_type: 'refresh_token', refresh_token: 'RT' })
    fake(() => json(200, { access_token: 'AT', api_domain: 'https://acme.pipedrive.com.evil.example' }))
    await expect(pipedriveExchange('c')).rejects.toThrow(/not a Pipedrive host/)
    fake(() => json(401, { success: false, error: 'invalid_grant' }))
    await expect(pipedriveRefresh('RT', [])).rejects.toMatchObject({ auth: true })
    expect(() => pipedriveDomain('http://acme.pipedrive.com')).toThrow()
  })

  it('revoke sends the refresh token with the token type hint', async () => {
    fake(() => new Response(null, { status: 200 }))
    expect(await pipedriveRevoke('RT')).toBe(true)
    expect(path(calls[0])).toBe('https://oauth.pipedrive.com/oauth/revoke')
    expect(Object.fromEntries(calls[0].form!)).toEqual({ token: 'RT', token_type_hint: 'refresh_token' })
  })

  it('persons: exact email search then read; create with a primary email; patch only what is given', async () => {
    fake(c => c.url.pathname.endsWith('/persons/search') ? json(200, { success: true, data: { items: [{ result_score: 1, item: { id: 42 } }] } })
      : c.method === 'GET' ? json(200, { success: true, data: { id: 42, name: 'Ana Ruiz', first_name: 'Ana', last_name: 'Ruiz', emails: [{ value: 'ana@example.com', primary: true }], phones: [{ value: '555', primary: true }], update_time: '2026-11-01T10:00:00Z' } })
      : json(200, { success: true, data: { id: 42 } }))
    const pd = pipedriveClient(tokens(), DOMAIN)
    const r = await pd.upsertContact({ email: 'Ana@Example.com', lastName: 'Ruiz-Lopez', firstName: 'Ana' })
    expect(r).toMatchObject({ created: false, contact: { id: '42', email: 'ana@example.com', lastName: 'Ruiz-Lopez' } })
    expect(path(calls[0])).toBe(`${DOMAIN}/api/v2/persons/search`)
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ term: 'ana@example.com', fields: 'email', exact_match: 'true', limit: '1' })
    expect(calls[2]).toMatchObject({ method: 'PATCH', json: { name: 'Ana Ruiz-Lopez' } })
    expect(calls.every(c => c.headers.get('authorization') === 'Bearer access-1')).toBe(true)
    calls.length = 0
    fake(c => c.url.pathname.endsWith('/persons/search') ? json(200, { success: true, data: { items: [] } }) : json(201, { success: true, data: { id: 77, name: 'new', emails: [{ value: 'new@example.com', primary: true }] } }))
    expect(await pd.upsertContact({ email: 'new@example.com', phone: '+15550001111' })).toMatchObject({ created: true, contact: { id: '77' } })
    expect(calls[1].json).toEqual({ name: 'new', emails: [{ value: 'new@example.com', primary: true, label: 'work' }], phones: [{ value: '+15550001111', primary: true, label: 'work' }] })
  })

  it('activities, notes, deal stage, deals and changed people', async () => {
    fake(c => c.url.pathname.endsWith('/persons') && c.method === 'GET' ? json(200, { success: true, data: [{ id: 1, name: 'A', update_time: '2026-11-02T00:00:00Z' }], additional_data: { next_cursor: 'cur2' } })
      : c.url.pathname.includes('/deals') && c.method === 'GET' ? json(200, { success: true, data: [{ id: 9, title: 'Lease 4B', stage_id: 3, status: 'open' }], additional_data: { next_cursor: null } })
      : json(200, { success: true, data: { id: 5, stage_id: 4 } }))
    const pd = pipedriveClient(tokens(), DOMAIN)
    await pd.createTask({ contact: { id: '42', kind: 'contact' }, subject: 'Follow up', body: 'tour', dueAt: new Date('2026-11-09T12:00:00Z') })
    expect(calls[0]).toMatchObject({ method: 'POST', json: { subject: 'Follow up', type: 'task', due_date: '2026-11-09', participants: [{ person_id: 42, primary: true }], note: 'tour' } })
    expect(path(calls[0])).toBe(`${DOMAIN}/api/v2/activities`)
    await pd.addNote({ contact: { id: '42', kind: 'contact' }, body: 'hello' })
    expect(path(calls[1])).toBe(`${DOMAIN}/api/v1/notes`)
    expect(calls[1].json).toEqual({ content: 'hello', person_id: 42 })
    expect(await pd.updateDealStage('5', '4')).toEqual({ id: '5', stage: '4' })
    expect(calls[2]).toMatchObject({ method: 'PATCH', json: { stage_id: 4 } })
    await expect(pd.updateDealStage('5', 'Won')).rejects.toThrow(/Pipedrive id/)
    const ch = await pd.listChangedContacts({ since: new Date('2026-11-01T00:00:00.000Z') })
    expect(ch).toMatchObject({ next: 'cur2', contacts: [{ id: '1' }] })
    const q = calls.at(-1)!.url.searchParams
    expect(Object.fromEntries(q)).toMatchObject({ updated_since: '2026-11-01T00:00:00Z', sort_by: 'update_time', sort_direction: 'asc', limit: '100' })
    expect(await pd.listDeals({ personId: '42' })).toEqual({ deals: [{ id: '9', title: 'Lease 4B', stageId: '3', status: 'open' }], next: null })
    expect(calls.at(-1)!.url.searchParams.get('person_id')).toBe('42')
  })

  it('401 refreshes once and repeats; 429 backs off', async () => {
    const t = tokens()
    fake((_c, n) => n === 1 ? json(401, { success: false, error: 'unauthorized access' }) : n === 2 ? json(429, {}, { 'retry-after': '1' }) : json(200, { success: true, data: { id: 1, company_id: 123, company_name: 'Acme' } }))
    expect(await pipedriveClient(t, DOMAIN).me()).toEqual({ companyId: '123', companyName: 'Acme', userId: '1' })
    expect(t.refreshed).toEqual(['access-1'])
    expect(waits).toEqual([1000])
  })
})
