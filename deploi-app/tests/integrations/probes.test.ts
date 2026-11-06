/**
 * Test probes for every provider against fake HTTP layers that follow each provider's documented request
 * and response shapes. Nothing leaves the machine. Each probe is read-only and says what it read in words.
 */
import './helpers'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { runProbe, setProbeStripeFetch, type ConnRef } from '../../lib/integrations/probes'
import { integrationDef } from '../../lib/integrations/registry'
import { probeAndRecord } from '../../lib/integrations/check'
import { setTransportOverride, resetThrottleState } from '../../lib/connectors/shopify/client'
import { setWooTransportOverride } from '../../lib/connectors/woocommerce/client'
import { setOfficeFetch, setOfficeSleep } from '../../lib/office/http'
import { setEmailFetch } from '../../lib/email/adapters/http'
import { resetOffice } from '../office/helpers'
import { connectSyntheticOffice } from '../../lib/office/connections'
import { injectOfficeFault } from '../../lib/office/synthetic'
import type { IntegrationKey } from '../../lib/integrations/types'
import { NW, HB, realOffice, realMailbox, realStore, cleanIntegrations, fakeFetch, json } from './helpers'
import { merchantActor } from '../merchant/helpers'

const ready = await prepareDb()
const ref = async (key: IntegrationKey, id: string): Promise<ConnRef> => (await admin(db => integrationDef(key).connections(db, null))).find(c => c.id === id)!

describe.skipIf(!ready)('test probes per provider (fake HTTP layers)', () => {
  beforeEach(async () => { await cleanIntegrations(); await resetOffice(HB); setOfficeSleep(async () => {}) })
  afterEach(() => { setTransportOverride(null); setWooTransportOverride(null); setOfficeFetch(null); setOfficeSleep(null); setEmailFetch(null); setProbeStripeFetch(null); resetThrottleState() })
  afterAll(async () => { if (ready) { await cleanIntegrations(); await resetOffice(HB, { enable: false }) } })

  it('Shopify: the Admin GraphQL shop query, with the throttle headroom from extensions.cost; 401 is an authorization failure', async () => {
    const id = await realStore(HB.org, 'shopify', 'probe-shop.myshopify.com')
    const seen: { operationName: string }[] = []
    setTransportOverride(() => async body => { seen.push(body); return { status: 200, json: { data: { shop: { name: 'Probe Shop', ianaTimezone: 'UTC' } }, extensions: { cost: { requestedQueryCost: 1, actualQueryCost: 1, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1999, restoreRate: 100 } } } } } })
    const r = await runProbe(await ref('shopify', id))
    expect(r).toMatchObject({ ok: true, code: null, detail: { rateLimitAvailable: 1999, rateLimitMax: 2000, rateLimitRestorePerSecond: 100 } })
    expect(r.message).toBe('Shopify answered: read the shop "Probe Shop".')
    expect(seen.map(s => s.operationName)).toEqual(['DeploiShop'])
    setTransportOverride(() => async () => ({ status: 401, json: { errors: '[API] Invalid API key or access token' } }))
    expect(await runProbe(await ref('shopify', id))).toMatchObject({ ok: false, code: 'auth' })
  })

  it('WooCommerce: GET /wp-json/wc/v3/system_status with Basic auth; a refused key is an authorization failure', async () => {
    const id = await realStore(HB.org, 'woocommerce', 'https://shop.probe.integration.example')
    const reqs: { method: string; url: string; auth: string | undefined }[] = []
    let status = 200
    setWooTransportOverride(() => async req => {
      reqs.push({ method: req.method, url: req.url, auth: req.headers.authorization })
      return status === 200 ? { status, headers: {}, body: JSON.stringify({ environment: { version: '8.9.1', wp_version: '6.6' } }) } : { status, headers: {}, body: JSON.stringify({ code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.' }) }
    })
    const r = await runProbe(await ref('woocommerce', id))
    expect(r).toMatchObject({ ok: true, message: 'The store answered: WooCommerce 8.9.1.' })
    expect(reqs[0]).toMatchObject({ method: 'GET', url: 'https://shop.probe.integration.example/wp-json/wc/v3/system_status' })
    expect(reqs[0].auth).toMatch(/^Basic /)
    status = 401
    const bad = await runProbe(await ref('woocommerce', id))
    expect(bad).toMatchObject({ ok: false, code: 'auth' })
    expect(bad.message).toMatch(/refused Deploi's API key/)
    expect(JSON.stringify(bad)).not.toMatch(/ck_|cs_/)
  })

  it('HubSpot: GET /crm/v3/objects/contacts?limit=1 with the bearer token; rate-limit headers become headroom; 401 marks the connection for reconnection', async () => {
    const row = await realOffice(HB.org, 'hubspot')
    const f = fakeFetch(() => json(200, { results: [{ id: '1', properties: { email: 'private@person.example' } }] }, { 'x-hubspot-ratelimit-remaining': '98', 'x-hubspot-ratelimit-max': '100', 'x-hubspot-ratelimit-daily-remaining': '249000', 'x-hubspot-ratelimit-daily': '250000' }))
    setOfficeFetch(f.fetch)
    const r = await runProbe(await ref('hubspot', row.id))
    expect(r).toMatchObject({ ok: true, detail: { rateLimitRemaining: 98, rateLimitMax: 100, dailyRemaining: 249000, dailyMax: 250000 } })
    expect(r.message).not.toMatch(/private@person/) // what was read, never its content
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: 'https://api.hubapi.com/crm/v3/objects/contacts?limit=1&archived=false' })
    expect(f.calls[0].headers.authorization).toBe('Bearer hubspot-access-token')
    setOfficeFetch(fakeFetch(() => json(401, { status: 'error', message: 'Authentication credentials not found.', category: 'INVALID_AUTHENTICATION' })).fetch)
    const out = await probeAndRecord(await ref('hubspot', row.id), 'manual')
    expect(out).toMatchObject({ ok: false, code: 'auth', previous: 'connected', status: 'needs_reauth' })
    expect(await admin(db => db.one('select status from office_connections where id = $1', [row.id]))).toEqual({ status: 'needs_reauth' })
  })

  it('Google Calendar: POST /calendar/v3/freeBusy for the next hour (busy times only)', async () => {
    const row = await realOffice(HB.org, 'google_calendar')
    const f = fakeFetch((_u, init) => { const b = JSON.parse(String(init.body)); return json(200, { kind: 'calendar#freeBusy', calendars: { [b.items[0].id]: { busy: [{ start: b.timeMin, end: b.timeMax }] } } }) })
    setOfficeFetch(f.fetch)
    const r = await runProbe(await ref('google_calendar', row.id))
    expect(r).toMatchObject({ ok: true, message: 'Google Calendar answered: availability for the next hour (1 busy block).' })
    expect(f.calls[0]).toMatchObject({ method: 'POST', url: 'https://www.googleapis.com/calendar/v3/freeBusy' })
    expect(JSON.parse(f.calls[0].body!).items).toEqual([{ id: 'primary' }])
    setOfficeFetch(fakeFetch(() => json(403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED' } })).fetch)
    expect(await runProbe(await ref('google_calendar', row.id))).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('QuickBooks: GET /v3/company/{realmId}/companyinfo/{realmId}; 5xx is retried, then a server error', async () => {
    const row = await realOffice(HB.org, 'quickbooks')
    const f = fakeFetch(() => json(200, { CompanyInfo: { CompanyName: 'Harbor Books LLC', Id: '1' }, time: '2026-11-05T10:00:00Z' }))
    setOfficeFetch(f.fetch)
    expect(await runProbe(await ref('quickbooks', row.id))).toMatchObject({ ok: true, message: 'QuickBooks answered: read the company "Harbor Books LLC".' })
    expect(f.calls[0].url).toMatch(/^https:\/\/quickbooks\.api\.intuit\.com\/v3\/company\/9130355\/companyinfo\/9130355\?minorversion=\d+$/)
    const down = fakeFetch(() => json(503, { Fault: { type: 'SystemFault', Error: [{ code: '10000' }] } }))
    setOfficeFetch(down.fetch)
    expect(await runProbe(await ref('quickbooks', row.id))).toMatchObject({ ok: false, code: 'server' })
    expect(down.calls.length).toBe(4) // retried with bounded backoff (reads only)
  })

  it('Gmail and Microsoft: the signed-in identity; a different account is identity_changed', async () => {
    const g = await realMailbox(HB.org, 'gmail', 'owner@integrations.example')
    const m = await realMailbox(HB.org, 'microsoft', 'ops@integrations.example')
    let gmailAs = 'owner@integrations.example'
    const f = fakeFetch(u => u.startsWith('https://openidconnect.googleapis.com/v1/userinfo') ? json(200, { email: gmailAs, email_verified: true })
      : u.startsWith('https://graph.microsoft.com/v1.0/me') ? json(200, { mail: null, userPrincipalName: 'ops@integrations.example', displayName: 'Ops' }) : json(404, {}))
    setEmailFetch(f.fetch)
    expect(await runProbe(await ref('gmail', g.id))).toMatchObject({ ok: true, message: 'Google answered: signed in as owner@integrations.example.' })
    expect(await runProbe(await ref('microsoft', m.id))).toMatchObject({ ok: true, message: 'Microsoft answered: signed in as ops@integrations.example.' })
    expect(f.calls.find(c => c.url.includes('graph.microsoft.com'))!.url).toBe('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName')
    gmailAs = 'someone-else@integrations.example'
    expect(await runProbe(await ref('gmail', g.id))).toMatchObject({ ok: false, code: 'identity_changed' })
    setEmailFetch(fakeFetch(() => json(401, { error: { code: 401, message: 'Invalid Credentials' } })).fetch)
    const out = await probeAndRecord(await ref('gmail', g.id), 'manual')
    expect(out).toMatchObject({ code: 'auth', status: 'needs_reauth' })
    expect(await admin(db => db.one('select status from email_accounts where id = $1', [g.id]))).toEqual({ status: 'needs_reauth' })
  })

  it('Stripe: GET /v1/customers/{id} with the secret key; Deploi Email: configuration only, nothing sent', async () => {
    const saved = { k: process.env.STRIPE_SECRET_KEY, d: process.env.AGENT_MAIL_DOMAIN, r: process.env.RESEND_API_KEY }
    process.env.STRIPE_SECRET_KEY = 'sk_test_probe'
    try {
      await admin(db => db.query(`insert into billing_customers (org_id, external_id) values ($1, 'cus_probeHB') on conflict (org_id) do nothing`, [HB.org]))
      const cust = (await admin(db => integrationDef('stripe').connections(db, HB.org)))[0]
      const f = fakeFetch(u => u.endsWith('/v1/customers/cus_probeHB') ? json(200, { id: 'cus_probeHB', object: 'customer', livemode: false }) : json(404, { error: { type: 'invalid_request_error', message: 'No such customer' } }))
      setProbeStripeFetch(f.fetch)
      expect(await runProbe(cust)).toMatchObject({ ok: true, message: 'Stripe answered: your billing account exists.', detail: { livemode: false } })
      expect(f.calls[0]).toMatchObject({ method: 'GET', url: 'https://api.stripe.com/v1/customers/cus_probeHB' })
      expect(f.calls[0].headers.authorization).toBe('Bearer sk_test_probe')
      setProbeStripeFetch(fakeFetch(() => json(200, { id: 'cus_probeHB', deleted: true })).fetch)
      expect(await runProbe(cust)).toMatchObject({ ok: false, code: 'not_found' })

      const mailbox: ConnRef = { integration: 'agent_mailbox', id: '00000000-0000-4000-8000-000000000001', orgId: HB.org, label: 'scout.ab12@agents.example', rawStatus: 'active', reason: null, synthetic: false, external: 'scout.ab12@agents.example', connectedAt: null }
      delete process.env.AGENT_MAIL_DOMAIN; delete process.env.RESEND_API_KEY
      const off = await runProbe(mailbox)
      expect(off).toMatchObject({ ok: false, code: 'not_configured' })
      expect(off.message).not.toMatch(/[A-Z]+_[A-Z]+/) // no environment variable names
      process.env.AGENT_MAIL_DOMAIN = 'agents.example'; process.env.RESEND_API_KEY = 're_test'
      expect((await runProbe(mailbox)).message).toMatch(/No message was sent/)
    } finally {
      for (const [k, v] of [['STRIPE_SECRET_KEY', saved.k], ['AGENT_MAIL_DOMAIN', saved.d], ['RESEND_API_KEY', saved.r]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  })

  it('synthetic connections are probed through the synthetic providers (no HTTP), and a probe that hangs times out', async () => {
    const actor = await merchantActor(HB)
    const syn = await connectSyntheticOffice(actor, 'hubspot', { demoData: false })
    expect(await runProbe(await ref('hubspot', syn.id))).toMatchObject({ ok: true, message: 'HubSpot answered a contacts read (synthetic test portal).' })
    await injectOfficeFault(syn.id, { op: '*', mode: 'auth' })
    expect(await runProbe(await ref('hubspot', syn.id))).toMatchObject({ ok: false, code: 'auth' })
    const real = await realOffice(HB.org, 'quickbooks')
    setOfficeFetch(() => new Promise<Response>(() => {}))
    const t = await runProbe(await ref('quickbooks', real.id), 50)
    expect(t).toMatchObject({ ok: false, code: 'timeout' })
    expect(t.latencyMs).toBeLessThan(5000)
  })
})
