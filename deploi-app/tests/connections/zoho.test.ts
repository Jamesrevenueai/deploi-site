import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { zohoAuthorizeUrl, zohoClient, zohoDc, zohoExchange, zohoRefresh, zohoRevoke, ZOHO_SCOPES } from '../../lib/office/zoho'
import { calls, fake, json, path, resetFake, tokens } from './fake-http'

const ENV = { ZOHO_CLIENT_ID: 'z-client', ZOHO_CLIENT_SECRET: 'z-secret', APP_URL: 'https://app.getdeploi.com' }

describe('Zoho CRM (fake HTTP; no real call is made)', () => {
  beforeEach(() => { Object.assign(process.env, ENV) })
  afterEach(() => { resetFake(); for (const k of [...Object.keys(ENV), 'ZOHO_DEFAULT_DC']) delete process.env[k] })

  it('data centers: .com, .eu, .in and .com.au are known; anything else is refused', () => {
    expect(zohoDc('eu')).toBe('eu')
    expect(zohoDc('https://accounts.zoho.com.au')).toBe('com.au')
    expect(zohoDc('https://www.zohoapis.in')).toBe('in')
    expect(zohoDc('https://accounts.zoho.evil.example')).toBeNull()
    expect(zohoDc('https://accounts.zoho.cn')).toBeNull()
  })

  it('consent: offline access with consent prompt, every CRM scope, on the default accounts server', () => {
    const u = new URL(zohoAuthorizeUrl('st'))
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.zoho.com/oauth/v2/auth')
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: 'code', client_id: 'z-client', scope: ZOHO_SCOPES.join(','), redirect_uri: 'https://app.getdeploi.com/api/office/oauth/zoho/callback', access_type: 'offline', prompt: 'consent', state: 'st' })
    process.env.ZOHO_DEFAULT_DC = 'eu'
    expect(zohoAuthorizeUrl('st')).toMatch(/^https:\/\/accounts\.zoho\.eu\//)
  })

  it('the code is exchanged on the accounts server named by the callback; its API domain must be the same data center', async () => {
    fake(() => json(200, { access_token: 'AT', refresh_token: 'RT', api_domain: 'https://www.zohoapis.eu', token_type: 'Bearer', expires_in: 3600 }))
    expect(await zohoExchange('code', 'https://accounts.zoho.eu')).toMatchObject({ accessToken: 'AT', refreshToken: 'RT', dc: 'eu', apiDomain: 'https://www.zohoapis.eu', expiresIn: 3600 })
    expect(path(calls[0])).toBe('https://accounts.zoho.eu/oauth/v2/token')
    expect(Object.fromEntries(calls[0].form!)).toEqual({ grant_type: 'authorization_code', client_id: 'z-client', client_secret: 'z-secret', redirect_uri: 'https://app.getdeploi.com/api/office/oauth/zoho/callback', code: 'code' })
    fake(() => json(200, { access_token: 'AT', api_domain: 'https://www.zohoapis.com' }))
    await expect(zohoExchange('code', 'https://accounts.zoho.eu')).rejects.toThrow(/another data center/)
    calls.length = 0
    await expect(zohoExchange('code', 'https://accounts.zoho.evil.example')).rejects.toThrow(/does not know/)
    expect(calls).toHaveLength(0) // nothing was sent to an unknown server
    fake(() => json(200, { error: 'invalid_code' })) // Zoho answers 200 with an error for a refused code
    await expect(zohoExchange('code', null)).rejects.toMatchObject({ auth: true })
  })

  it('refresh and revoke go to the accounts server of the connection\'s data center', async () => {
    fake(c => c.url.pathname.endsWith('/revoke') ? json(200, { status: 'success' }) : json(200, { access_token: 'AT2', expires_in: 3600, api_domain: 'https://www.zohoapis.in' }))
    expect(await zohoRefresh('RT', ['x'], 'https://www.zohoapis.in')).toMatchObject({ accessToken: 'AT2', refreshToken: 'RT' })
    expect(path(calls[0])).toBe('https://accounts.zoho.in/oauth/v2/token')
    expect(Object.fromEntries(calls[0].form!)).toEqual({ grant_type: 'refresh_token', client_id: 'z-client', client_secret: 'z-secret', refresh_token: 'RT' })
    expect(await zohoRevoke('RT', 'https://www.zohoapis.in')).toBe(true)
    expect(path(calls[1])).toBe('https://accounts.zoho.in/oauth/v2/token/revoke')
    expect(calls[1].url.searchParams.get('token')).toBe('RT')
    await expect(zohoRefresh('RT', [], null)).rejects.toMatchObject({ auth: true })
  })

  it('Zoho-oauthtoken header; search answers 204 when nothing matches; contacts before leads', async () => {
    fake(c => c.url.pathname.includes('/Contacts/search') ? new Response(null, { status: 204 })
      : json(200, { data: [{ id: '4876876000000624001', First_Name: 'Ana', Last_Name: 'Ruiz', Email: 'ana@example.com', Company: 'Ruiz', Modified_Time: '2026-11-01T10:00:00+00:00' }] }))
    const z = zohoClient(tokens(), 'https://www.zohoapis.com.au')
    expect(await z.findContactByEmail('ana@example.com')).toMatchObject({ id: '4876876000000624001', kind: 'lead', company: 'Ruiz' })
    expect(path(calls[0])).toBe('https://www.zohoapis.com.au/crm/v6/Contacts/search')
    expect(calls[0].url.searchParams.get('email')).toBe('ana@example.com')
    expect(calls[0].headers.get('authorization')).toBe('Zoho-oauthtoken access-1')
    expect(path(calls[1])).toBe('https://www.zohoapis.com.au/crm/v6/Leads/search')
  })

  it('creates a lead, links tasks to a lead with What_Id and $se_module, notes, deal stage; a refused write is an error', async () => {
    fake(c => c.url.pathname.endsWith('/search') ? new Response(null, { status: 204 })
      : c.method === 'GET' ? json(200, { data: [{ id: '4876876000000999001', Stage: 'Closed Won' }] })
      : json(c.method === 'POST' ? 201 : 200, { data: [{ code: 'SUCCESS', status: 'success', details: { id: '4876876000000777001' }, message: 'record added' }] }))
    const z = zohoClient(tokens(), 'https://www.zohoapis.com')
    expect(await z.upsertContact({ email: 'new@example.com', firstName: 'Neil', source: 'Zumper' })).toMatchObject({ created: true, contact: { id: '4876876000000777001', kind: 'lead' } })
    const create = calls.find(c => c.method === 'POST')!
    expect(path(create)).toBe('https://www.zohoapis.com/crm/v6/Leads')
    expect(create.json).toEqual({ data: [{ First_Name: 'Neil', Email: 'new@example.com', Last_Name: 'Neil', Lead_Source: 'Zumper' }], trigger: [] })
    calls.length = 0
    await z.createTask({ contact: { id: '4876876000000777001', kind: 'lead' }, subject: 'Call', dueAt: new Date('2026-11-12T09:00:00Z') })
    expect(calls[0].json).toEqual({ data: [{ Subject: 'Call', Due_Date: '2026-11-12', Status: 'Not Started', What_Id: { id: '4876876000000777001' }, $se_module: 'Leads' }], trigger: [] })
    await z.createTask({ contact: { id: '4876876000000777002', kind: 'contact' }, subject: 'Call', dueAt: new Date('2026-11-12T09:00:00Z') })
    expect((calls[1].json as { data: Record<string, unknown>[] }).data[0].Who_Id).toEqual({ id: '4876876000000777002' })
    await z.addNote({ contact: { id: '4876876000000777002', kind: 'contact' }, body: 'Title line\nmore' })
    expect(path(calls[2])).toBe('https://www.zohoapis.com/crm/v6/Contacts/4876876000000777002/Notes')
    expect(calls[2].json).toEqual({ data: [{ Note_Title: 'Title line', Note_Content: 'Title line\nmore' }] })
    expect(await z.updateDealStage('4876876000000999001', 'Closed Won')).toEqual({ id: '4876876000000999001', stage: 'Closed Won' })
    expect(calls[3]).toMatchObject({ method: 'PUT', json: { data: [{ Stage: 'Closed Won' }], trigger: [] } })
    fake(() => json(200, { data: [{ code: 'INVALID_DATA', status: 'error', message: 'invalid data', details: { api_name: 'Stage' } }] }))
    await expect(z.updateRecord('Deals', '4876876000000999001', { Stage: 'x' })).rejects.toThrow(/INVALID_DATA/)
    await expect(z.getRecord('Accounts' as never, '4876876000000999001')).rejects.toThrow(/not available/)
  })

  it('changed people: If-Modified-Since, Contacts pages then Leads pages', async () => {
    fake(c => json(200, { data: [{ id: '4876876000000000001', Email: 'x@example.com', Modified_Time: '2026-11-02T00:00:00+00:00' }], info: { more_records: c.url.pathname.endsWith('/Contacts') && c.url.searchParams.get('page') === '1' } }))
    const z = zohoClient(tokens(), 'https://www.zohoapis.com')
    const since = new Date('2026-11-01T00:00:00Z')
    const p1 = await z.listChangedContacts({ since })
    expect(p1.next).toBe('c:2')
    expect(calls[0].headers.get('if-modified-since')).toBe('2026-11-01T00:00:00+00:00')
    expect(calls[0].url.searchParams.get('fields')).toBe('First_Name,Last_Name,Email,Phone,Modified_Time,Account_Name')
    expect((await z.listChangedContacts({ since, page: p1.next })).next).toBe('l:1')
    const p3 = await z.listChangedContacts({ since, page: 'l:1' })
    expect(p3).toMatchObject({ next: null, contacts: [{ kind: 'lead' }] })
  })

  it('a 401 refreshes once and repeats', async () => {
    const t = tokens()
    fake((_c, n) => n === 1 ? json(401, { code: 'INVALID_TOKEN', message: 'invalid oauth token' }) : json(200, { org: [{ id: '777', company_name: 'Acme EU' }] }))
    expect(await zohoClient(t, 'https://www.zohoapis.eu').org()).toEqual({ id: '777', name: 'Acme EU' })
    expect(t.refreshed).toEqual(['access-1'])
    expect(calls[1].headers.get('authorization')).toBe('Zoho-oauthtoken access-2')
    expect(() => zohoClient(t, 'https://www.zohoapis.cn')).toThrow()
  })
})
