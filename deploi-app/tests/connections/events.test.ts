/**
 * Change detection -> agent events, against local Postgres with fake provider HTTP: CRM / QuickBooks / Buildium polls,
 * new Outlook mail and lead emails, and the Outlook calendar delta. Every change reaches the handlers exactly once.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { onEvent, type AgentEvent } from '../../lib/events'
import { emitConnectionEvent } from '../../lib/connections/events'
import { pollConnection, POLL_EVERY_MS } from '../../lib/connections/poll'
import { readCursor } from '../../lib/connections/cursors'
import { syncOutlookCalendar, CALENDAR_STREAM, outlookCalendarFor } from '../../lib/outlook/calendar'
import { storeProviderMessage } from '../../lib/email/inbox-sync'
import { encryptSecret } from '../../lib/connectors/credentials'
import { setEmailFetch } from '../../lib/email/adapters/http'
import { microsoftAdapter } from '../../lib/email/adapters/microsoft'
import type { EmailAccountRow } from '../../lib/email/accounts'
import type { OfficeConnectionRow } from '../../lib/office/connections'
import type { CrmClient, CrmContact } from '../../lib/crm/types'
import type { BuildiumApi } from '../../lib/buildium/client'
import type { ProviderMessage } from '../../lib/email/readers/parse'
import { NW, HB, resetOffice } from '../office/helpers'
import { calls, fake, json, resetFake } from './fake-http'

const ready = await prepareDb()
const seen: AgentEvent[] = []
for (const t of ['crm.contact.changed', 'buildium.workorder.changed', 'mail.received', 'lead.email', 'calendar.changed', 'invoice.changed']) onEvent(t, 'test:w3', async (_db, e) => { seen.push(e) })
let failing = false
onEvent('crm.contact.changed', 'test:w3-failing', async db => { if (failing) { await db.query('select 1/0'); } })

const ORGS = [NW.org, HB.org]
const clean = async () => {
  await resetOffice(NW); await resetOffice(HB)
  await admin(async db => { for (const t of ['connection_events', 'connection_sync_cursors']) await db.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]) })
  await admin(db => db.query(`delete from email_accounts where org_id = any($1::uuid[]) and address like '%@events.example'`, [ORGS]))
}

async function officeRow(orgId: string, provider: 'salesforce' | 'buildium' | 'quickbooks', apiBase: string | null) {
  return (await admin(db => db.one<OfficeConnectionRow>(`insert into office_connections (org_id, provider, is_synthetic, external_account_id, display_name, scopes, connected_by, api_base) values ($1,$2,false,$3,$2,'{}','test',$4) returning *`,
    [orgId, provider, provider === 'quickbooks' ? '4620816365000000001' : `${provider}-1`, apiBase])))!
}
const person = (id: string, updatedAt: string): CrmContact => ({ id, kind: 'contact', email: `${id}@example.com`, firstName: null, lastName: null, phone: null, company: null, updatedAt })

async function msAccount(orgId: string, scopes: string[], expiresIn = '1 hour') {
  return admin(async db => {
    const acc = (await db.one<EmailAccountRow>(`insert into email_accounts (org_id, provider, address, status, granted_scopes, can_send, can_read, is_synthetic, connected_by) values ($1,'microsoft',$2,'active',$3,true,true,false,'test') returning *`,
      [orgId, `owner-${Math.random().toString(36).slice(2, 8)}@events.example`, scopes]))!
    const a = encryptSecret('ms-access-1', `email-account:${acc.id}:access`), r = encryptSecret('ms-refresh-1', `email-account:${acc.id}:refresh`)
    await db.query(`insert into email_credentials (account_id, org_id, key_id, ciphertext, refresh_ciphertext, scopes, expires_at) values ($1,$2,$3,$4,$5,$6, now() + $7::interval)`, [acc.id, orgId, a.keyId, a.ciphertext, r.ciphertext, scopes, expiresIn])
    return acc
  })
}

describe.skipIf(!ready)('change detection -> agent events (exactly once)', () => {
  beforeEach(async () => { seen.length = 0; failing = false; await clean() })
  afterEach(() => { resetFake(); setEmailFetch(null); delete process.env.MICROSOFT_OAUTH_CLIENT_ID; delete process.env.MICROSOFT_OAUTH_CLIENT_SECRET })
  afterAll(async () => { if (ready) { await clean(); await resetOffice(NW, { enable: false }); await resetOffice(HB, { enable: false }) } })

  it('the emitter dedupes on (organization, source, externalId), keeps no payload, and a failing handler does not undo the caller', async () => {
    const e = { source: 'crm' as const, type: 'crm.contact.changed', orgId: NW.org, externalId: 'salesforce:contact:1:v1', occurredAt: new Date().toISOString(), payload: { secretish: 'Ana Ruiz' } }
    failing = true
    const r = await admin(async db => {
      const a = await emitConnectionEvent(db, e)
      const b = await emitConnectionEvent(db, e)
      await db.query(`insert into connection_sync_cursors (org_id, connection_id, stream) values ($1, gen_random_uuid(), 'test.after')`, [NW.org]) // the caller's transaction still works
      return [a, b]
    })
    expect(r).toEqual(['emitted', 'duplicate'])
    expect(seen).toHaveLength(1)
    expect(await admin(db => db.one<{ n: string }>(`select count(*)::text as n from connection_sync_cursors where stream = 'test.after' and org_id = $1`, [NW.org]))).toEqual({ n: '1' })
    const row = await admin(db => db.one<Record<string, unknown>>('select * from connection_events where org_id = $1', [NW.org]))
    expect(JSON.stringify(row)).not.toContain('Ana Ruiz')
    expect(row!.handlers).toBe(1) // the failing handler is not counted
    // the same id in another organization is another event
    expect(await admin(db => emitConnectionEvent(db, { ...e, orgId: HB.org }))).toBe('emitted')
    await expect(admin(db => emitConnectionEvent(db, { ...e, source: 'shopify' }))).rejects.toThrow(/not a connection event source/)
  })

  it('CRM poll: each changed person once; the position moves forward; a repeat poll and an overlapping page emit nothing new', async () => {
    const c = await officeRow(NW.org, 'salesforce', 'https://acme.my.salesforce.com')
    const pages: Record<string, { contacts: CrmContact[]; next: string | null }> = {
      first: { contacts: [person('a', '2026-11-05T10:00:00.000Z'), person('b', '2026-11-05T11:00:00.000Z')], next: 'p2' },
      p2: { contacts: [person('c', '2026-11-05T12:00:00.000Z')], next: null },
    }
    const sinces: string[] = []
    const crm = { provider: 'salesforce', listChangedContacts: async ({ since, page }: { since: Date; page?: string | null }) => { sinces.push(since.toISOString()); return pages[page ?? 'first'] } } as unknown as CrmClient
    const now = new Date('2026-11-05T13:00:00.000Z')
    const r1 = await pollConnection(c, { now, clients: { crm } })
    expect(r1).toEqual([{ stream: 'crm.contacts', status: 'polled', changes: 3, emitted: 3 }])
    expect(sinces[0]).toBe(new Date(now.getTime() - 24 * 3600e3).toISOString()) // first poll looks back a day
    expect(seen.map(e => e.externalId)).toEqual(['salesforce:contact:a:2026-11-05T10:00:00.000Z', 'salesforce:contact:b:2026-11-05T11:00:00.000Z', 'salesforce:contact:c:2026-11-05T12:00:00.000Z'])
    expect(seen[0]).toMatchObject({ source: 'crm', orgId: NW.org, payload: { provider: 'salesforce', connectionId: c.id } })
    expect((await admin(db => readCursor(db, c.id, 'crm.contacts')))!.sync_position).toBe('2026-11-05T12:00:00.000Z')
    // not due again within the interval
    expect((await pollConnection(c, { now: new Date(now.getTime() + 60_000), clients: { crm } }))[0].status).toBe('not_due')
    // next poll starts from the newest change; the provider returns c again (">=" overlap): nothing new is emitted
    pages.first = { contacts: [person('c', '2026-11-05T12:00:00.000Z')], next: null }
    const r3 = await pollConnection(c, { now: new Date(now.getTime() + POLL_EVERY_MS), clients: { crm } })
    expect(r3[0]).toMatchObject({ status: 'polled', changes: 1, emitted: 0 })
    expect(sinces.at(-1)).toBe('2026-11-05T12:00:00.000Z')
    expect(seen).toHaveLength(3)
  })

  it('a failed poll keeps the position and records the error code; the next poll retries from the same place', async () => {
    const c = await officeRow(NW.org, 'salesforce', 'https://acme.my.salesforce.com')
    const { OfficeHttpError } = await import('../../lib/office/http')
    let fail = true
    const crm = { listChangedContacts: async () => { if (fail) throw new OfficeHttpError(429, 'rate_limited', 'Salesforce answered 429 (rate limited after retries)', 'salesforce'); return { contacts: [person('z', '2026-11-05T09:00:00.000Z')], next: null } } } as unknown as CrmClient
    const now = new Date('2026-11-05T13:00:00.000Z')
    expect((await pollConnection(c, { now, clients: { crm } }))[0]).toMatchObject({ status: 'failed', code: 'rate_limited' })
    const cur = (await admin(db => readCursor(db, c.id, 'crm.contacts')))!
    expect(cur).toMatchObject({ sync_position: null, last_error_code: 'rate_limited' })
    fail = false
    expect((await pollConnection(c, { now: new Date(now.getTime() + POLL_EVERY_MS), clients: { crm } }))[0]).toMatchObject({ status: 'polled', emitted: 1 })
    expect((await admin(db => readCursor(db, c.id, 'crm.contacts')))!.last_error_code).toBeNull()
  })

  it('Buildium poll: work orders, leases, applications and requests each become their own events, once', async () => {
    const c = await officeRow(NW.org, 'buildium', 'https://api.buildium.com')
    const b = {
      listWorkOrders: async () => [{ id: '812', updatedAt: '2026-11-05T10:00:00Z', status: 'Completed' }],
      listLeases: async () => [],
      listResidentRequests: async () => [],
      listApplicants: async () => [{ id: '55', name: 'A', updatedAt: '2026-11-05T10:00:00Z' }],
      listApplications: async () => [{ id: '70', applicantId: '55', status: 'Approved', submittedAt: null, updatedAt: '2026-11-05T10:30:00Z' }],
    } as unknown as BuildiumApi
    const now = new Date('2026-11-05T13:00:00.000Z')
    const out = await pollConnection(c, { now, clients: { buildium: b } })
    expect(out.map(o => [o.stream, o.emitted])).toEqual([['buildium.workorders', 1], ['buildium.leases', 0], ['buildium.residentrequests', 0], ['buildium.applications', 1]])
    await pollConnection(c, { now: new Date(now.getTime() + POLL_EVERY_MS), clients: { buildium: b } })
    expect(await admin(db => db.query<{ type: string; external_id: string }>('select type, external_id from connection_events where org_id = $1 order by type', [NW.org]))).toEqual([
      { type: 'buildium.application.changed', external_id: 'buildium.applications:70:2026-11-05T10:30:00Z' }, { type: 'buildium.workorder.changed', external_id: 'buildium.workorders:812:2026-11-05T10:00:00Z' }])
  })

  it('QuickBooks poll reads the change feed through the real client and fake HTTP', async () => {
    const c = await officeRow(NW.org, 'quickbooks', null)
    await admin(async db => { const { saveOfficeTokens } = await import('../../lib/office/credentials'); await saveOfficeTokens(db, c.id, NW.org, { accessToken: 'qb-at', refreshToken: 'qb-rt', expiresIn: 3600, scopes: [] }) })
    fake(() => json(200, { CDCResponse: [{ QueryResponse: [{ Invoice: [{ Id: '130', MetaData: { LastUpdatedTime: '2026-11-05T10:00:00-08:00' } }] }] }] }))
    const out = await pollConnection(c, { now: new Date() })
    expect(out[0]).toMatchObject({ stream: 'quickbooks.cdc', emitted: 1 })
    expect(calls[0].url.pathname).toBe('/v3/company/4620816365000000001/cdc')
    expect(calls[0].headers.get('authorization')).toBe('Bearer qb-at')
    expect(seen[0]).toMatchObject({ type: 'invoice.changed', source: 'quickbooks', payload: { id: '130', deleted: false } })
  })

  it('new Outlook mail: mail.received for every new message, lead.email for a Zillow lead, once each; quarantined mail is never a lead', async () => {
    const acc = await msAccount(NW.org, ['Mail.Send', 'Mail.ReadWrite', 'Calendars.ReadWrite'])
    const msg = (id: string, o: Partial<ProviderMessage> = {}): ProviderMessage => ({ providerMessageId: id, providerThreadId: `conv-${id}`, internetMessageId: `<${id}@mail.example>`, from: 'rentalclientservices@zillowrentals.com', to: [acc.address], cc: [],
      subject: 'New Zillow Rentals lead for 1420 NW Lovejoy St #4B', text: 'Name: Maya Thompson\nEmail: maya.thompson@gmail.com\nPhone: (503) 555-0147\nMove-in date: 12/01/2026', inReplyTo: null, references: [], receivedAt: '2026-11-05T12:00:00.000Z',
      headers: {}, authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, attachments: [], truncated: false, ...o })
    const r1 = await storeProviderMessage(acc, msg('AAMk-1'), 'test')
    expect(r1).not.toBe('duplicate')
    expect(await storeProviderMessage(acc, msg('AAMk-1'), 'test')).toBe('duplicate')
    const types = seen.map(e => e.type)
    expect(types.filter(t => t === 'mail.received')).toHaveLength(1)
    const lead = seen.find(e => e.type === 'lead.email')!
    expect(lead).toMatchObject({ source: 'outlook', orgId: NW.org, externalId: 'lead:AAMk-1', payload: { senderVerified: true, lead: { source: 'zillow', name: 'Maya Thompson', email: 'maya.thompson@gmail.com', phone: '+15035550147', moveIn: '2026-12-01' } } })
    // a newsletter from a known sender is mail, not a lead
    seen.length = 0
    await storeProviderMessage(acc, msg('AAMk-2', { subject: 'Weekly market report', text: 'Prices rose.' }), 'test')
    expect(seen.map(e => e.type)).toEqual(['mail.received'])
  })

  it('Gmail mail emits nothing (deferred)', async () => {
    const acc = (await admin(db => db.one<EmailAccountRow>(`insert into email_accounts (org_id, provider, address, status, granted_scopes, can_send, can_read, is_synthetic, connected_by) values ($1,'gmail','g@events.example','active','{}',true,true,false,'test') returning *`, [NW.org])))!
    await storeProviderMessage(acc, { providerMessageId: 'g1', providerThreadId: 't', internetMessageId: '<g1@x>', from: 'leads@zumper.com', to: [], cc: [], subject: 'New lead for 9 Birch Ct', text: 'Email: a@b.example', inReplyTo: null, references: [], receivedAt: new Date().toISOString(), headers: {}, authentication: null, attachments: [], truncated: false }, 'test')
    expect(seen).toEqual([])
  })

  it('Microsoft 365 consent with calendar asks for Mail.ReadWrite, Mail.Send and Calendars.ReadWrite with offline access', () => {
    expect(microsoftAdapter.scopesFor({ read: true, calendar: true })).toEqual(['openid', 'email', 'profile', 'offline_access', 'User.Read', 'Mail.Send', 'Mail.ReadWrite', 'Calendars.ReadWrite'])
    expect(microsoftAdapter.scopesFor({ read: false })).not.toContain('Calendars.ReadWrite')
  })

  it('Outlook calendar: an account without calendar access is refused; the delta is followed, removed events reported, each change once', async () => {
    const noCal = await msAccount(NW.org, ['Mail.Send'])
    expect(() => outlookCalendarFor(noCal)).toThrow(/without calendar access/)
    expect(await syncOutlookCalendar(noCal.id)).toMatchObject({ status: 'not_readable' })
    const acc = await msAccount(NW.org, ['Mail.Send', 'Mail.ReadWrite', 'Calendars.ReadWrite'])
    const ev = (id: string, ck: string) => ({ id, subject: 'Tour 4B', start: { dateTime: '2026-11-08T17:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-08T17:30:00.0000000', timeZone: 'UTC' }, changeKey: ck, attendees: [{ emailAddress: { address: 'Maya@Example.com' } }], lastModifiedDateTime: '2026-11-05T10:00:00Z' })
    const DL = 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=round1'
    fake(c => c.url.searchParams.get('$skiptoken') ? json(200, { value: [{ id: 'AAMkEvent-gone-0001', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': DL })
      : c.url.searchParams.get('$deltatoken') ? json(200, { value: [ev('AAMkEvent-tour-0001', 'ck2')], '@odata.deltaLink': `${DL}2` })
      : json(200, { value: [ev('AAMkEvent-tour-0001', 'ck1')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=p2' }))
    expect(await syncOutlookCalendar(acc.id)).toEqual({ status: 'synced', changed: 1, removed: 1, emitted: 2 })
    expect(calls[0].url.pathname).toBe('/v1.0/me/calendarView/delta')
    expect(calls[0].url.searchParams.get('startDateTime')).toMatch(/Z$/)
    expect(calls[0].headers.get('authorization')).toBe('Bearer ms-access-1')
    expect(calls[0].headers.get('prefer')).toContain('odata.maxpagesize=50')
    expect((await admin(db => readCursor(db, acc.id, CALENDAR_STREAM)))!.sync_position).toBe(DL)
    expect(seen.map(e => [e.type, e.externalId])).toEqual([['calendar.changed', 'outlook:AAMkEvent-tour-0001:ck1'], ['calendar.changed', 'outlook:AAMkEvent-gone-0001:removed']])
    expect(seen[0].payload).toMatchObject({ change: 'updated', event: { start: '2026-11-08T17:00:00.0000000Z'.replace('.0000000', ''), attendees: ['maya@example.com'] } })
    // next round continues from the stored delta link: a changed changeKey is a new change
    expect(await syncOutlookCalendar(acc.id)).toMatchObject({ changed: 1, emitted: 1 })
    expect(calls.at(-1)!.url.searchParams.get('$deltatoken')).toBe('round1')
  })

  it('Outlook calendar: a 401 refreshes the Microsoft token once (refresh token grant) and repeats; an expired delta (410) restarts the window', async () => {
    process.env.MICROSOFT_OAUTH_CLIENT_ID = 'ms-client'; process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 'ms-secret'
    const acc = await msAccount(NW.org, ['Mail.Send', 'Mail.ReadWrite', 'Calendars.ReadWrite'])
    await admin(db => db.query(`insert into connection_sync_cursors (org_id, connection_id, stream, sync_position) values ($1,$2,$3,$4)`, [NW.org, acc.id, CALENDAR_STREAM, 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=old']))
    const tokenCalls: URLSearchParams[] = []
    setEmailFetch(async (_url, init) => { tokenCalls.push(new URLSearchParams(String(init.body))); return new Response(JSON.stringify({ access_token: 'ms-access-2', refresh_token: 'ms-refresh-2', expires_in: 3600, scope: 'Mail.Send Mail.ReadWrite Calendars.ReadWrite' }), { status: 200 }) })
    fake(c => c.headers.get('authorization') === 'Bearer ms-access-1' ? json(401, { error: { code: 'InvalidAuthenticationToken' } })
      : c.url.searchParams.get('$deltatoken') === 'old' ? json(410, { error: { code: 'SyncStateNotFound' } })
      : json(200, { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=fresh' }))
    expect(await syncOutlookCalendar(acc.id)).toMatchObject({ status: 'synced', changed: 0 })
    expect(tokenCalls).toHaveLength(1)
    expect(Object.fromEntries(tokenCalls[0])).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'ms-refresh-1', client_id: 'ms-client' })
    expect(calls.map(c => [c.headers.get('authorization'), c.url.searchParams.get('$deltatoken')])).toEqual([['Bearer ms-access-1', 'old'], ['Bearer ms-access-2', 'old'], ['Bearer ms-access-2', null]])
    expect((await admin(db => readCursor(db, acc.id, CALENDAR_STREAM)))!.sync_position).toContain('fresh')
  })

  it('Outlook calendar client: list, create (with transactionId), update and cancel request shapes', async () => {
    const acc = await msAccount(NW.org, ['Calendars.ReadWrite'])
    fake(c => c.method === 'GET' ? json(200, { value: [] }) : c.url.pathname.endsWith('/cancel') ? new Response(null, { status: 202 }) : json(c.method === 'POST' ? 201 : 200, { id: 'AAMkEvent-new-00001', subject: 'Tour', changeKey: 'k' }))
    const cal = outlookCalendarFor(acc)
    await cal.listEvents({ start: new Date('2026-11-08T00:00:00Z'), end: new Date('2026-11-09T00:00:00Z') })
    expect(calls[0].url.pathname).toBe('/v1.0/me/calendarView')
    expect(Object.fromEntries(calls[0].url.searchParams)).toMatchObject({ startDateTime: '2026-11-08T00:00:00Z', endDateTime: '2026-11-09T00:00:00Z', $orderby: 'start/dateTime', $top: '50' })
    expect(calls[0].headers.get('prefer')).toBe('outlook.timezone="UTC"')
    await expect(cal.createEvent({ subject: 'Tour', start: '2026-11-08T17:00:00', end: '2026-11-08T17:30:00', transactionId: 'x' })).rejects.toThrow(/transactionId/)
    await cal.createEvent({ subject: 'Tour 4B', body: 'See you there', start: '2026-11-08T17:00:00', end: '2026-11-08T17:30:00', timeZone: 'Pacific Standard Time', attendees: ['maya@example.com'], online: true, transactionId: 'deploi-meeting-123' })
    expect(calls[1]).toMatchObject({ method: 'POST', json: { subject: 'Tour 4B', body: { contentType: 'Text', content: 'See you there' }, start: { dateTime: '2026-11-08T17:00:00', timeZone: 'Pacific Standard Time' },
      end: { dateTime: '2026-11-08T17:30:00', timeZone: 'Pacific Standard Time' }, attendees: [{ emailAddress: { address: 'maya@example.com' }, type: 'required' }], transactionId: 'deploi-meeting-123', isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } })
    await cal.updateEvent('AAMkEvent-new-00001', { start: '2026-11-08T18:00:00', end: '2026-11-08T18:30:00' })
    expect(calls[2]).toMatchObject({ method: 'PATCH', json: { start: { dateTime: '2026-11-08T18:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-08T18:30:00', timeZone: 'UTC' } } })
    expect(calls[2].url.pathname).toBe('/v1.0/me/events/AAMkEvent-new-00001')
    await cal.cancelEvent('AAMkEvent-new-00001', 'Rescheduling')
    expect(calls[3]).toMatchObject({ method: 'POST', json: { comment: 'Rescheduling' } })
    await expect(cal.updateEvent('../../me', {})).rejects.toThrow(/event id/)
  })
})
