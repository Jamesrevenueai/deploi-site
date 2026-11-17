/**
 * Office provider cost metering: real HubSpot, Google Calendar, QuickBooks, Gmail and Microsoft Graph calls
 * are counted in workflow_costs per organization, provider and month, the same way as the Shopify and
 * WooCommerce counters (in memory, then flushed), and appear in the unit-economics report. Synthetic
 * connections are free.
 */
import './helpers'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { flushWorkflowCounters, monthOf, pendingWorkflowCounts } from '../../lib/ai/meter'
import { calendarFor, hubspotFor, quickbooksFor } from '../../lib/office/providers'
import { setOfficeFetch, setOfficeSleep } from '../../lib/office/http'
import { emailAdapter } from '../../lib/email/adapters'
import { setEmailFetch } from '../../lib/email/adapters/http'
import { accountRef } from '../../lib/email/accounts'
import { connectSyntheticOffice } from '../../lib/office/connections'
import { economicsReport, currentMonth } from '../../lib/platform/economics'
import { diagnostics } from '../../lib/integrations/diagnostics'
import { resetOffice } from '../office/helpers'
import { merchantActor } from '../merchant/helpers'
import { HB, NW, realOffice, realMailbox, cleanIntegrations, fakeFetch, json } from './helpers'

const ready = await prepareDb()
const pending = (org: string, c: string) => pendingWorkflowCounts().get(`${org}|provider_call|${c}`) ?? 0

describe.skipIf(!ready)('Office provider metering', () => {
  beforeEach(async () => { await flushWorkflowCounters(); await cleanIntegrations(); await resetOffice(HB); setOfficeSleep(async () => {}) })
  afterEach(() => { setOfficeFetch(null); setEmailFetch(null); setOfficeSleep(null) })
  afterAll(async () => { if (ready) { await flushWorkflowCounters(); await cleanIntegrations(); await resetOffice(HB, { enable: false }) } })

  it('counts each real HubSpot, Calendar and QuickBooks request for the organization; synthetic ones are not counted', async () => {
    const hs = await realOffice(HB.org, 'hubspot'), cal = await realOffice(HB.org, 'google_calendar'), qb = await realOffice(HB.org, 'quickbooks')
    setOfficeFetch(fakeFetch(u => u.includes('hubapi.com') ? json(200, { id: '51', properties: { email: 'lead@lead.example', lifecyclestage: 'lead' } })
      : u.includes('freeBusy') ? json(200, { calendars: { primary: { busy: [] } } })
      : json(200, { CompanyInfo: { CompanyName: 'Harbor Books' } })).fetch)
    await hubspotFor(hs).getContact('51')
    await hubspotFor(hs).getDeal('9')
    const now = new Date()
    await calendarFor(cal).freeBusy({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 3600e3).toISOString(), timeZone: 'UTC' })
    await quickbooksFor(qb).companyInfo()
    expect([pending(HB.org, 'hubspot'), pending(HB.org, 'google_calendar'), pending(HB.org, 'quickbooks')]).toEqual([2, 1, 1])
    expect(pending(NW.org, 'hubspot')).toBe(0)

    await admin(db => db.query(`update office_connections set status = 'disconnected' where id = $1`, [cal.id])) // one live calendar per org: replace it with a synthetic one
    const syn = await connectSyntheticOffice(await merchantActor(HB), 'google_calendar', { timezone: 'UTC' })
    await calendarFor(syn).freeBusy({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 3600e3).toISOString(), timeZone: 'UTC' })
    expect(pending(HB.org, 'google_calendar')).toBe(1)
  })

  it('counts Gmail API and Microsoft Graph calls made for an account; identity reads without an account are not attributed', async () => {
    const g = await realMailbox(HB.org, 'gmail', 'meter@integrations.example')
    const m = await realMailbox(HB.org, 'microsoft', 'graph@integrations.example')
    setEmailFetch(fakeFetch(u => u.includes('gmail.googleapis.com') ? json(200, { messages: [] }) : u.includes('graph.microsoft.com') ? json(200, { value: [] }) : json(404, {})).fetch)
    const gr = { ...accountRef(g), scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }
    const mr = { ...accountRef(m), scopes: ['Mail.ReadBasic'] }
    await emailAdapter('gmail').findSent(gr, 'tok', '<a@b>')
    await emailAdapter('gmail').listReplies(gr, 'tok', { internetMessageId: '<a@b>', providerThreadId: null }) // no thread id: answered without a call, still one adapter call
    await emailAdapter('microsoft').findSent(mr, 'tok', '<c@d>')
    expect(pending(HB.org, 'gmail')).toBe(2)
    expect(pending(HB.org, 'microsoft_graph')).toBe(1)
    // canRead/canSend take scopes, not an account: never counted
    emailAdapter('gmail').canRead(['x'])
    expect(pending(HB.org, 'gmail')).toBe(2)
  })

  it('flushes to workflow_costs per organization, provider and month; unit economics and diagnostics include them', async () => {
    const hs = await realOffice(HB.org, 'hubspot')
    setOfficeFetch(fakeFetch(() => json(200, { id: '51', properties: {} })).fetch)
    for (let i = 0; i < 3; i++) await hubspotFor(hs).getContact('51')
    const qb = await realOffice(HB.org, 'quickbooks')
    await quickbooksFor(qb).companyInfo().catch(() => null)
    await flushWorkflowCounters()
    const rows = await admin(db => db.query<{ connector: string; count: string; month: string }>(`select connector, count::text, month::text from workflow_costs where org_id = $1 and metric = 'provider_call' order by connector`, [HB.org]))
    expect(rows).toEqual([{ connector: 'hubspot', count: '3', month: monthOf(new Date()) }, { connector: 'quickbooks', count: '1', month: monthOf(new Date()) }])
    const report = await admin(db => economicsReport(db, currentMonth()))
    const hb = report.orgs.find(o => o.orgId === HB.org)!
    expect(hb.providerCalls).toMatchObject({ hubspot: 3, quickbooks: 1 })
    expect(hb.providerCostUsd).toBeCloseTo(4 * 0.0001, 6)
    expect((await diagnostics(HB.org, 'hubspot', { live: false })).callsThisMonth).toBe(3)
  })
})
