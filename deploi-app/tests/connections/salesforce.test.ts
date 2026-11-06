import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { salesforceAuthorizeUrl, salesforceClient, salesforceExchange, salesforceIds, salesforceInstance, salesforceRefresh, salesforceRevoke, soql } from '../../lib/office/salesforce'
import { OfficeHttpError } from '../../lib/office/http'
import { calls, fake, json, path, resetFake, tokens, waits } from './fake-http'

const ENV = { SALESFORCE_CLIENT_ID: 'sf-client', SALESFORCE_CLIENT_SECRET: 'sf-secret', APP_URL: 'https://app.getdeploi.com' }
const INSTANCE = 'https://acme.my.salesforce.com'
const V = '/services/data/v62.0'

describe('Salesforce (fake HTTP; no real call is made)', () => {
  beforeEach(() => { Object.assign(process.env, ENV) })
  afterEach(() => { resetFake(); for (const k of [...Object.keys(ENV), 'SALESFORCE_LOGIN_URL']) delete process.env[k] })

  it('consent URL: web server flow with PKCE (S256), api + refresh_token scopes, the registered redirect', () => {
    const u = new URL(salesforceAuthorizeUrl('state-1', 'challenge-1'))
    expect(`${u.origin}${u.pathname}`).toBe('https://login.salesforce.com/services/oauth2/authorize')
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: 'code', client_id: 'sf-client', redirect_uri: 'https://app.getdeploi.com/api/office/oauth/salesforce/callback',
      scope: 'api refresh_token', state: 'state-1', code_challenge: 'challenge-1', code_challenge_method: 'S256' })
    process.env.SALESFORCE_LOGIN_URL = 'https://test.salesforce.com'
    expect(salesforceAuthorizeUrl('s', 'c')).toMatch(/^https:\/\/test\.salesforce\.com\//)
    process.env.SALESFORCE_LOGIN_URL = 'https://evil.example'
    expect(salesforceAuthorizeUrl('s', 'c')).toMatch(/^https:\/\/login\.salesforce\.com\//) // anything else falls back to production login
  })

  it('code exchange sends the verifier and client credentials as a form; instance URL and org id come from the answer', async () => {
    fake(() => json(200, { access_token: 'AT', refresh_token: 'RT', instance_url: INSTANCE, id: 'https://login.salesforce.com/id/00D5g000004XyzAEAS/0055g00000AbCdEAAV', scope: 'api refresh_token', token_type: 'Bearer' }))
    const g = await salesforceExchange('the-code', 'the-verifier')
    expect(g).toMatchObject({ accessToken: 'AT', refreshToken: 'RT', instanceUrl: INSTANCE, orgId: '00D5g000004XyzAEAS', userId: '0055g00000AbCdEAAV', scopes: ['api', 'refresh_token'], expiresIn: null })
    expect(path(calls[0])).toBe('https://login.salesforce.com/services/oauth2/token')
    expect(Object.fromEntries(calls[0].form!)).toEqual({ grant_type: 'authorization_code', code: 'the-code', client_id: 'sf-client', client_secret: 'sf-secret', redirect_uri: 'https://app.getdeploi.com/api/office/oauth/salesforce/callback', code_verifier: 'the-verifier' })
  })

  it('refuses an instance URL that is not Salesforce, and a refused exchange or refresh is an auth error', async () => {
    expect(() => salesforceInstance('https://acme.my.salesforce.com.evil.example')).toThrow()
    expect(() => salesforceInstance('http://acme.my.salesforce.com')).toThrow()
    expect(salesforceInstance('https://acme--uat.sandbox.my.salesforce.com/path')).toBe('https://acme--uat.sandbox.my.salesforce.com')
    expect(() => salesforceIds('https://login.salesforce.com/id/nope')).toThrow()
    fake(() => json(200, { access_token: 'AT', instance_url: 'https://attacker.example', id: 'https://login.salesforce.com/id/00D5g000004XyzAEAS/0055g00000AbCdEAAV' }))
    await expect(salesforceExchange('c', 'v')).rejects.toBeInstanceOf(OfficeHttpError)
    fake(() => json(400, { error: 'invalid_grant', error_description: 'expired access/refresh token' }))
    await expect(salesforceRefresh('RT', ['api'])).rejects.toMatchObject({ auth: true })
  })

  it('refresh keeps the refresh token (Salesforce does not rotate it) and reports a moved instance', async () => {
    fake(() => json(200, { access_token: 'AT2', instance_url: 'https://acme2.my.salesforce.com', id: 'x' }))
    expect(await salesforceRefresh('RT', ['api', 'refresh_token'])).toMatchObject({ accessToken: 'AT2', refreshToken: 'RT', apiBase: 'https://acme2.my.salesforce.com' })
    expect(Object.fromEntries(calls[0].form!)).toEqual({ grant_type: 'refresh_token', refresh_token: 'RT', client_id: 'sf-client', client_secret: 'sf-secret' })
  })

  it('revoke posts the token to the revoke endpoint', async () => {
    fake(() => new Response('', { status: 200 }))
    expect(await salesforceRevoke('RT')).toBe(true)
    expect(path(calls[0])).toBe('https://login.salesforce.com/services/oauth2/revoke')
    expect(calls[0].form!.get('token')).toBe('RT')
  })

  it('finds a contact before an unconverted lead, with the email escaped in SOQL', async () => {
    fake(c => {
      const q = c.url.searchParams.get('q') ?? ''
      if (q.includes('FROM Contact')) return json(200, { records: [], done: true })
      return json(200, { records: [{ attributes: { type: 'Lead' }, Id: '00Q5g00000ABCDEFGH', FirstName: 'Ana', LastName: 'Ruiz', Email: 'ANA@example.com', Phone: '555', Company: 'Ruiz LLC', LastModifiedDate: '2026-11-01T10:00:00.000+0000' }], done: true })
    })
    const sf = salesforceClient(tokens(), INSTANCE)
    expect(await sf.findContactByEmail('ana@example.com')).toEqual({ id: '00Q5g00000ABCDEFGH', kind: 'lead', email: 'ana@example.com', firstName: 'Ana', lastName: 'Ruiz', phone: '555', company: 'Ruiz LLC', updatedAt: '2026-11-01T10:00:00.000+0000' })
    expect(path(calls[0])).toBe(`${INSTANCE}${V}/query`)
    expect(calls[0].url.searchParams.get('q')).toContain("FROM Contact WHERE Email = 'ana@example.com'")
    expect(calls[1].url.searchParams.get('q')).toContain('IsConverted = false')
    expect(calls[0].headers.get('authorization')).toBe('Bearer access-1')
    expect(soql("o'brien\\x@example.com")).toBe("'o\\'brien\\\\x@example.com'")
    await expect(sf.findContactByEmail("x' OR Name != '")).rejects.toThrow()
  })

  it('upsert creates a Lead with the fields Salesforce requires, or updates the record it found', async () => {
    fake(c => c.method === 'GET' ? json(200, { records: [] }) : json(201, { id: '00Q5g00000NEWLEADX', success: true, errors: [] }))
    const sf = salesforceClient(tokens(), INSTANCE)
    const r = await sf.upsertContact({ email: 'new@example.com', firstName: 'Neil', phone: '+15551234567', source: 'Zillow' })
    expect(r).toMatchObject({ created: true, contact: { id: '00Q5g00000NEWLEADX', kind: 'lead', lastName: 'Neil', company: 'Not provided' } })
    const post = calls.find(c => c.method === 'POST')!
    expect(path(post)).toBe(`${INSTANCE}${V}/sobjects/Lead/`)
    expect(post.json).toEqual({ FirstName: 'Neil', Phone: '+15551234567', Email: 'new@example.com', LastName: 'Neil', Company: 'Not provided', LeadSource: 'Zillow' })
    calls.length = 0
    fake(c => c.method === 'GET' ? json(200, { records: (c.url.searchParams.get('q') ?? '').includes('FROM Contact') ? [{ Id: '0035g00000CONTACT1', Email: 'a@b.co', LastName: 'B' }] : [] }) : new Response(null, { status: 204 }))
    expect(await sf.upsertContact({ email: 'a@b.co', phone: '777' })).toMatchObject({ created: false, contact: { id: '0035g00000CONTACT1', kind: 'contact', phone: '777' } })
    const patch = calls.find(c => c.method === 'PATCH')!
    expect(path(patch)).toBe(`${INSTANCE}${V}/sobjects/Contact/0035g00000CONTACT1`)
    expect(patch.json).toEqual({ Phone: '777' })
  })

  it('tasks, notes, opportunity stage and generic record reads go to the right objects', async () => {
    fake(c => c.method === 'POST' ? json(201, { id: c.url.pathname.includes('/Task/') ? '00T5g00000TASK0001' : '0025g00000NOTE0001', success: true })
      : c.method === 'PATCH' ? new Response(null, { status: 204 }) : json(200, { Id: '0065g00000OPP00001', StageName: 'Closed Won' }))
    const sf = salesforceClient(tokens(), INSTANCE)
    const who = { id: '00Q5g00000ABCDEFGH', kind: 'lead' as const }
    expect(await sf.createTask({ contact: who, subject: 'Call back', body: 'About the tour', dueAt: new Date('2026-11-10T15:00:00Z') })).toEqual({ id: '00T5g00000TASK0001' })
    expect(calls[0].json).toEqual({ WhoId: who.id, Subject: 'Call back', Description: 'About the tour', ActivityDate: '2026-11-10', Status: 'Not Started', Priority: 'Normal' })
    await sf.addNote({ contact: who, body: 'Asked about parking\nand pets' })
    expect(path(calls[1])).toBe(`${INSTANCE}${V}/sobjects/Note/`)
    expect(calls[1].json).toEqual({ ParentId: who.id, Title: 'Asked about parking', Body: 'Asked about parking\nand pets' })
    expect(await sf.updateDealStage('0065g00000OPP00001', 'Closed Won')).toEqual({ id: '0065g00000OPP00001', stage: 'Closed Won' })
    expect(calls[2]).toMatchObject({ method: 'PATCH', json: { StageName: 'Closed Won' } })
    expect(path(calls[3])).toBe(`${INSTANCE}${V}/sobjects/Opportunity/0065g00000OPP00001`)
    await expect(sf.getRecord('Account' as never, '0065g00000OPP00001')).rejects.toThrow(/not available/)
    await expect(sf.updateRecord('Lead', '../../x', {})).rejects.toThrow(/record id/)
  })

  it('a 401 refreshes the token once and repeats the call; a second 401 is final', async () => {
    const t = tokens()
    fake((c, n) => n === 1 ? json(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]) : json(200, { records: [{ Name: 'Acme Inc' }] }))
    expect(await salesforceClient(t, INSTANCE).identity()).toEqual({ orgName: 'Acme Inc' })
    expect(t.refreshed).toEqual(['access-1'])
    expect(calls.map(c => c.headers.get('authorization'))).toEqual(['Bearer access-1', 'Bearer access-2'])
    calls.length = 0
    fake(() => json(401, [{ errorCode: 'INVALID_SESSION_ID' }]))
    const e = await salesforceClient(tokens(), INSTANCE).identity().catch(x => x as OfficeHttpError)
    expect(e).toMatchObject({ code: 'auth', status: 401 })
    expect((e as Error).message).toContain('INVALID_SESSION_ID')
    expect(calls).toHaveLength(2)
  })

  it('429 backs off with Retry-After and retries (bounded)', async () => {
    fake((_c, n) => n < 3 ? json(429, [{ errorCode: 'REQUEST_LIMIT_EXCEEDED' }], { 'retry-after': '3' }) : json(200, { records: [] }))
    await salesforceClient(tokens(), INSTANCE).listChangedContacts({ since: new Date('2026-11-01T00:00:00Z') })
    expect(waits.slice(0, 2)).toEqual([3000, 3000])
    expect(calls[2].url.searchParams.get('q')).toContain('LastModifiedDate > 2026-11-01T00:00:00Z')
  })

  it('a client is never bound to a host other than a Salesforce instance', () => {
    expect(() => salesforceClient(tokens(), 'https://example.com')).toThrow()
  })
})
