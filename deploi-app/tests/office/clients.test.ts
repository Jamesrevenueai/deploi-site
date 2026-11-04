/** HubSpot and Google Calendar clients against a fake fetch: request shapes, pagination, 429 backoff, error classes. No real network. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { setOfficeFetch, setOfficeSleep, officeRequest, OfficeHttpError } from '../../lib/office/http'
import { hubspotClient, hubspotAuthorizeUrl, hubspotRefresh, HUBSPOT_SCOPES, NOTE_TO_CONTACT, TASK_TO_CONTACT } from '../../lib/office/hubspot'
import { calendarClient, googleAuthorizeUrl, googleRefresh, eventIdFor, CAL_EVENTS, CAL_FREEBUSY } from '../../lib/office/calendar'
import { OutboundBlocked } from '../../lib/net/outbound'

type Call = { url: string; method: string; headers: Headers; body: string | null }
let calls: Call[] = []
let replies: (Response | Error)[] = []
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const waits: number[] = []

beforeEach(() => {
  calls = []; replies = []; waits.length = 0
  setOfficeFetch(async (url, init) => {
    calls.push({ url, method: String(init.method ?? 'GET'), headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : null })
    const r = replies.shift()
    if (!r) throw new Error('unexpected request ' + url)
    if (r instanceof Error) throw r
    return r
  })
  setOfficeSleep(async ms => { waits.push(ms) })
  process.env.HUBSPOT_CLIENT_ID = 'hs-client'; process.env.HUBSPOT_CLIENT_SECRET = 'hs-secret'
  process.env.GOOGLE_CALENDAR_CLIENT_ID = 'g-client'; process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'g-secret'
})
afterEach(() => {
  setOfficeFetch(null); setOfficeSleep(null)
  for (const k of ['HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET', 'GOOGLE_CALENDAR_CLIENT_ID', 'GOOGLE_CALENDAR_CLIENT_SECRET']) delete process.env[k]
})

const hs = () => hubspotClient(async () => 'hs-token')
const cal = () => calendarClient(async () => 'g-token')
const contact = (id: string, email: string) => ({ id, properties: { email, firstname: 'Ana', company: 'Acme', lifecyclestage: 'lead', hs_email_optout: 'false', lastmodifieddate: '2026-11-04T10:00:00Z' } })

describe('HubSpot client', () => {
  it('searches leads with the lifecycle and modified-since filters, and pages with the after cursor', async () => {
    replies.push(json(200, { results: [contact('1', 'Ana@Acme.example')], paging: { next: { after: '1' } } }), json(200, { results: [contact('2', 'ben@bolt.example')] }))
    const since = new Date('2026-11-01T00:00:00Z')
    const p1 = await hs().searchLeads({ since, limit: 1 })
    expect(p1).toMatchObject({ next: '1', contacts: [{ id: '1', email: 'ana@acme.example', lifecycleStage: 'lead', optedOut: false, firstName: 'Ana' }] })
    const p2 = await hs().searchLeads({ since, after: p1.next, limit: 1 })
    expect(p2.next).toBeNull()
    expect(calls[0]).toMatchObject({ url: 'https://api.hubapi.com/crm/v3/objects/contacts/search', method: 'POST' })
    expect(calls[0].headers.get('authorization')).toBe('Bearer hs-token')
    const b0 = JSON.parse(calls[0].body!), b1 = JSON.parse(calls[1].body!)
    expect(b0.filterGroups[0].filters).toEqual([{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'lead' }, { propertyName: 'lastmodifieddate', operator: 'GTE', value: String(since.getTime()) }])
    expect(b0.properties).toEqual(expect.arrayContaining(['email', 'lifecyclestage', 'hs_email_optout']))
    expect(b0.after).toBeUndefined()
    expect(b1.after).toBe('1')
  })

  it('creates notes and tasks associated with the contact, updates a contact and a deal stage', async () => {
    replies.push(json(201, { id: '901' }), json(201, { id: '902' }), json(200, contact('5', 'a@b.example')), json(200, { id: '77', properties: { dealstage: 'qualifiedtobuy' } }))
    await hs().createNote({ contactId: '5', body: 'Logged deploiabc', timestamp: new Date('2026-11-04T12:00:00Z') })
    await hs().createTask({ contactId: '5', subject: 'Call', body: 'deploiabc', dueAt: new Date('2026-11-05T12:00:00Z') })
    await hs().updateContact('5', { lifecyclestage: 'opportunity' })
    expect((await hs().updateDealStage('77', 'qualifiedtobuy')).stage).toBe('qualifiedtobuy')
    const note = JSON.parse(calls[0].body!), task = JSON.parse(calls[1].body!)
    expect(calls[0].url).toBe('https://api.hubapi.com/crm/v3/objects/notes')
    expect(note).toEqual({ properties: { hs_timestamp: '2026-11-04T12:00:00.000Z', hs_note_body: 'Logged deploiabc' }, associations: [{ to: { id: '5' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }] }] })
    expect(task.associations[0].types[0].associationTypeId).toBe(TASK_TO_CONTACT)
    expect(task.properties).toMatchObject({ hs_task_subject: 'Call', hs_task_status: 'NOT_STARTED' })
    expect(calls[2]).toMatchObject({ method: 'PATCH', url: 'https://api.hubapi.com/crm/v3/objects/contacts/5' })
    expect(JSON.parse(calls[2].body!)).toEqual({ properties: { lifecyclestage: 'opportunity' } })
    expect(calls[3]).toMatchObject({ method: 'PATCH', url: 'https://api.hubapi.com/crm/v3/objects/deals/77' })
  })

  it('waits on 429 (Retry-After, bounded) and then succeeds; gives up after the retry limit', async () => {
    replies.push(json(429, {}, { 'retry-after': '2' }), json(429, {}), json(200, contact('1', 'a@b.example')))
    expect((await hs().getContact('1'))?.id).toBe('1')
    expect(waits).toEqual([2000, 2000])
    replies.push(json(429, {}, { 'retry-after': '600' }), json(429, {}), json(429, {}), json(429, {}))
    await expect(hs().getContact('1')).rejects.toMatchObject({ code: 'rate_limited', status: 429 })
    expect(Math.max(...waits)).toBeLessThanOrEqual(10_000)
  })

  it('classifies errors: 401 auth, 404 not found (null), 5xx and a lost answer are uncertain; a write is never retried on a network error', async () => {
    replies.push(json(401, { message: 'expired' }))
    await expect(hs().getContact('1')).rejects.toMatchObject({ code: 'auth' })
    replies.push(json(404, {}))
    expect(await hs().getContact('1')).toBeNull()
    replies.push(json(503, {}))
    const e = await hs().createNote({ contactId: '1', body: 'x', timestamp: new Date() }).catch(x => x)
    expect(e).toBeInstanceOf(OfficeHttpError)
    expect(e.uncertain).toBe(true)
    calls = []
    replies.push(new Error('socket hang up'))
    const n = await hs().createNote({ contactId: '1', body: 'x', timestamp: new Date() }).catch(x => x)
    expect(n).toMatchObject({ code: 'network' })
    expect(calls).toHaveLength(1)
    replies.push(new Error('reset'), json(200, contact('1', 'a@b.example')))
    expect((await hs().getContact('1'))?.id).toBe('1')
    // ids are validated before they reach a URL
    await expect(hs().getContact('1/../../owners')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('only reaches approved hosts', async () => {
    await expect(officeRequest('hubspot', 'https://evil.example/crm')).rejects.toBeInstanceOf(OutboundBlocked)
    await expect(officeRequest('google_calendar', 'https://api.hubapi.com/x')).rejects.toBeInstanceOf(OutboundBlocked)
  })

  it('authorize URL asks for exactly the documented scopes; refresh posts the refresh grant and flags a dead token', async () => {
    const u = new URL(hubspotAuthorizeUrl('st1'))
    expect(u.origin + u.pathname).toBe('https://app.hubspot.com/oauth/authorize')
    expect(u.searchParams.get('scope')!.split(' ')).toEqual([...HUBSPOT_SCOPES])
    expect(u.searchParams.get('state')).toBe('st1')
    replies.push(json(200, { access_token: 'new', refresh_token: 'r2', expires_in: 1800 }))
    expect(await hubspotRefresh('r1', [])).toMatchObject({ accessToken: 'new', refreshToken: 'r2', expiresIn: 1800 })
    expect(calls[0].url).toBe('https://api.hubapi.com/oauth/v1/token')
    expect(Object.fromEntries(new URLSearchParams(calls[0].body!))).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'hs-client' })
    replies.push(json(400, { error: 'BAD_REFRESH_TOKEN' }))
    await expect(hubspotRefresh('dead', [])).rejects.toMatchObject({ auth: true })
  })
})

describe('Google Calendar client', () => {
  it('authorize URL uses PKCE (S256), offline access and the narrow calendar scopes', () => {
    const verifier = 'v'.repeat(64)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const u = new URL(googleAuthorizeUrl('st2', challenge))
    expect(u.searchParams.get('code_challenge')).toBe(challenge)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('scope')!.split(' ')).toEqual(['openid', 'email', CAL_EVENTS, CAL_FREEBUSY])
  })

  it('queries free/busy for the calendar only', async () => {
    replies.push(json(200, { calendars: { primary: { busy: [{ start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z' }] } } }))
    const busy = await cal().freeBusy({ timeMin: '2026-11-05T00:00:00Z', timeMax: '2026-11-06T00:00:00Z', timeZone: 'Europe/London' })
    expect(busy).toEqual([{ start: '2026-11-05T10:00:00.000Z', end: '2026-11-05T11:00:00.000Z' }])
    expect(calls[0]).toMatchObject({ url: 'https://www.googleapis.com/calendar/v3/freeBusy', method: 'POST' })
    expect(JSON.parse(calls[0].body!)).toEqual({ timeMin: '2026-11-05T00:00:00Z', timeMax: '2026-11-06T00:00:00Z', timeZone: 'Europe/London', items: [{ id: 'primary' }] })
    replies.push(json(200, { calendars: { primary: { errors: [{ reason: 'notFound' }] } } }))
    await expect(cal().freeBusy({ timeMin: 'a', timeMax: 'b', timeZone: 'UTC' })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('inserts with a deterministic id, attendees, sendUpdates and a Meet request; a 409 reads the existing event back', async () => {
    const id = eventIdFor('org:meeting:1:event')
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/)
    expect(eventIdFor('org:meeting:1:event')).toBe(id)
    const ev = { id, status: 'confirmed', summary: 'Intro call', start: { dateTime: '2026-11-06T09:00:00Z' }, end: { dateTime: '2026-11-06T09:30:00Z' }, attendees: [{ email: 'ana@acme.example' }], hangoutLink: 'https://meet.google.com/abc' }
    replies.push(json(200, ev))
    const input = { id, summary: 'Intro call', description: 'd', start: '2026-11-06T09:00:00.000Z', end: '2026-11-06T09:30:00.000Z', timeZone: 'UTC', attendees: ['ana@acme.example'], meet: true, requestId: id }
    expect(await cal().insertEvent(input)).toMatchObject({ id, meetLink: 'https://meet.google.com/abc', attendees: ['ana@acme.example'] })
    const u = new URL(calls[0].url)
    expect(u.pathname).toBe('/calendar/v3/calendars/primary/events')
    expect(u.searchParams.get('sendUpdates')).toBe('all')
    expect(u.searchParams.get('conferenceDataVersion')).toBe('1')
    const body = JSON.parse(calls[0].body!)
    expect(body).toMatchObject({ id, attendees: [{ email: 'ana@acme.example' }], conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: 'hangoutsMeet' } } } })
    calls = []
    replies.push(json(409, { error: { status: 'ALREADY_EXISTS' } }), json(200, ev))
    expect((await cal().insertEvent({ ...input, meet: false })).id).toBe(id)
    expect(calls.map(c => c.method)).toEqual(['POST', 'GET'])
    expect(new URL(calls[0].url).searchParams.get('conferenceDataVersion')).toBeNull()
  })

  it('patches and deletes with sendUpdates; a deleted event is "already gone"; refresh flags invalid_grant', async () => {
    replies.push(json(200, { id: 'dplabc12', start: { dateTime: '2026-11-07T09:00:00Z' }, end: { dateTime: '2026-11-07T09:30:00Z' } }), json(204, null), json(410, {}))
    await cal().patchEvent('dplabc12', { start: '2026-11-07T09:00:00Z', end: '2026-11-07T09:30:00Z', timeZone: 'UTC' })
    expect(calls[0].method).toBe('PATCH')
    expect(new URL(calls[0].url).searchParams.get('sendUpdates')).toBe('all')
    expect(await cal().deleteEvent('dplabc12')).toBe('deleted')
    expect(await cal().deleteEvent('dplabc12')).toBe('already_gone')
    await expect(cal().getEvent('NOT-VALID')).rejects.toMatchObject({ code: 'invalid' })
    replies.push(json(400, { error: 'invalid_grant' }))
    await expect(googleRefresh('dead', [])).rejects.toMatchObject({ auth: true })
  })
})
