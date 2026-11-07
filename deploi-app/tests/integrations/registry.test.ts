/**
 * The registry's status for every integration and every state, what customers see (never an environment
 * variable name), what staff see, and organization isolation of status, actions and the API.
 */
import './helpers'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { INTEGRATIONS, customerView, integrationDef, integrationStatuses, missingEnv, reconnectIntegration, disconnectIntegration, scrubEnvNames, statusOf, testIntegration } from '../../lib/integrations/registry'
import { saveHealthState } from '../../lib/integrations/events'
import { INTEGRATION_KEYS, type HealthStatus, type IntegrationKey } from '../../lib/integrations/types'
import { connectSyntheticOffice } from '../../lib/office/connections'
import { resetOffice } from '../office/helpers'
import { merchantActor, staffActor } from '../merchant/helpers'
import { NW, HB, realMailbox, cleanIntegrations } from './helpers'

const ready = await prepareDb()

const ENV_NAMES = [...new Set(INTEGRATIONS.flatMap(d => d.env.map(v => v.name)))]
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  return fn().finally(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
}
const ALL_ENV: Record<string, string> = {
  SHOPIFY_API_KEY: 'k', SHOPIFY_API_SECRET: 's', CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), HUBSPOT_CLIENT_ID: 'h', HUBSPOT_CLIENT_SECRET: 'h',
  GOOGLE_CALENDAR_CLIENT_ID: 'g', GOOGLE_CALENDAR_CLIENT_SECRET: 'g', QUICKBOOKS_CLIENT_ID: 'q', QUICKBOOKS_CLIENT_SECRET: 'q', AGENT_MAIL_DOMAIN: 'agents.example', RESEND_API_KEY: 're_x',
  EMAIL_OAUTH_PROVIDERS: 'on', GOOGLE_OAUTH_CLIENT_ID: 'g', GOOGLE_OAUTH_CLIENT_SECRET: 'g', MICROSOFT_OAUTH_CLIENT_ID: 'm', MICROSOFT_OAUTH_CLIENT_SECRET: 'm',
  BILLING_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x',
  SALESFORCE_CLIENT_ID: 'sf', SALESFORCE_CLIENT_SECRET: 'sf', PIPEDRIVE_CLIENT_ID: 'pd', PIPEDRIVE_CLIENT_SECRET: 'pd', ZOHO_CLIENT_ID: 'z', ZOHO_CLIENT_SECRET: 'z',
}
const none = Object.fromEntries(ENV_NAMES.map(k => [k, undefined]))
const statusFor = async (orgId: string, key: IntegrationKey) => admin(db => statusOf(db, integrationDef(key), orgId))

describe.skipIf(!ready)('integration registry', () => {
  beforeEach(async () => { await cleanIntegrations(); await resetOffice(HB) })
  afterAll(async () => { if (ready) { await cleanIntegrations(); await resetOffice(HB, { enable: false }) } })

  it('describes every integration: key, suite, auth kind, scopes with reasons, setup variables and docs', () => {
    expect(INTEGRATIONS.map(d => d.key).sort()).toEqual([...INTEGRATION_KEYS].sort())
    for (const d of INTEGRATIONS) {
      expect(d.usedFor.length).toBeGreaterThan(10)
      expect(d.permissions.length).toBeGreaterThan(0)
      expect(d.docs).toMatch(/^docs\/[A-Z-]+\.md$/)
      expect(d.env.some(v => v.required)).toBe(true)
      for (const s of d.scopes) expect(s.why.length).toBeGreaterThan(8)
    }
    expect(integrationDef('hubspot').scopes.map(s => s.scope)).toEqual(['crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.deals.read', 'crm.objects.deals.write'])
  })

  it('not_configured without the settings, not_connected with them, for every integration with no connection', async () => {
    await withEnv(none, async () => {
      for (const k of INTEGRATION_KEYS) if (k !== 'shopify') expect((await statusFor(HB.org, k)).status, k).toBe('not_configured')
      expect(missingEnv(integrationDef('hubspot'))).toEqual(['HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET', 'CREDENTIALS_ENCRYPTION_KEY'])
    })
    await withEnv(ALL_ENV, async () => {
      for (const k of INTEGRATION_KEYS) if (k !== 'shopify') expect((await statusFor(HB.org, k)).status, k).toBe('not_connected')
    })
    // Gmail and Microsoft need the explicit switch: a client id alone is not "configured"
    await withEnv({ ...ALL_ENV, EMAIL_OAUTH_PROVIDERS: 'yes' }, async () => expect((await statusFor(HB.org, 'gmail')).status).toBe('not_configured'))
  })

  it('connected, needs_reauth and error from the connection rows and the health state, for each connection family', async () => {
    const actor = await merchantActor(HB)
    // store: the seeded synthetic Shopify store
    expect((await statusFor(HB.org, 'shopify')).status).toBe('connected')
    await admin(db => db.query(`update store_connections set status = 'error', status_reason = 'needs_reauth: refresh refused (HTTP 401)' where id = $1`, [HB.conn]))
    expect(await statusFor(HB.org, 'shopify')).toMatchObject({ status: 'needs_reauth', can: { reconnect: true } })
    await admin(db => db.query(`update store_connections set status = 'error', status_reason = 'the store answered 500' where id = $1`, [HB.conn]))
    expect((await statusFor(HB.org, 'shopify')).status).toBe('error')
    await admin(db => db.query(`update store_connections set status = 'active', status_reason = null where id = $1`, [HB.conn]))
    // office: synthetic HubSpot, Calendar and QuickBooks
    for (const p of ['hubspot', 'google_calendar', 'quickbooks'] as const) {
      const c = await connectSyntheticOffice(actor, p, { demoData: false })
      const v = await statusFor(HB.org, p)
      expect(v).toMatchObject({ status: 'connected', can: { test: true, reconnect: false, disconnect: true } })
      expect(v.detail).toMatch(/synthetic test account/)
      await admin(db => db.query(`update office_connections set status = 'needs_reauth', status_reason = 'the provider no longer accepts this connection (revoked or expired)' where id = $1`, [c.id]))
      expect(await statusFor(HB.org, p)).toMatchObject({ status: 'needs_reauth', connections: [{ id: c.id, reason: 'the provider no longer accepts this connection (revoked or expired)' }] })
    }
    // email: Gmail / Microsoft accounts
    const g = await realMailbox(HB.org, 'gmail', 'one@integrations.example')
    expect((await statusFor(HB.org, 'gmail')).status).toBe('connected')
    await admin(db => db.query(`update email_accounts set status = 'needs_reauth' where id = $1`, [g.id]))
    expect((await statusFor(HB.org, 'gmail')).status).toBe('needs_reauth')
    const m = await realMailbox(HB.org, 'microsoft', 'two@integrations.example')
    // repeated probe failures flip a connected row to error through the health state
    await admin(db => saveHealthState(db, { orgId: HB.org, integration: 'microsoft', connectionId: m.id, status: 'error', failures: 3, nextProbeAt: new Date(Date.now() + 4 * 3600e3), checkedAt: new Date(), ok: false, code: 'server', message: 'Microsoft did not answer properly.' }))
    expect(await statusFor(HB.org, 'microsoft')).toMatchObject({ status: 'error', lastError: { code: 'server', message: 'Microsoft did not answer properly.' }, connections: [{ consecutiveFailures: 3 }] })
    // stripe: the organization's billing customer
    await withEnv(ALL_ENV, async () => {
      await admin(db => db.query(`insert into billing_customers (org_id, external_id) values ($1, 'cus_probeHB2') on conflict (org_id) do nothing`, [HB.org]))
      expect((await statusFor(HB.org, 'stripe')).status).toBe('connected')
    })
    // the worst connection decides the integration's status
    const order: HealthStatus[] = (await integrationStatuses(HB.org)).map(i => i.status)
    expect(order).toHaveLength(INTEGRATION_KEYS.length)
  })

  it('customers never see environment variable names; staff do', async () => {
    await withEnv(none, async () => {
      const raw = await integrationStatuses(HB.org)
      expect(raw.find(i => i.key === 'quickbooks')!.missingEnv).toContain('QUICKBOOKS_CLIENT_ID')
      const shown = raw.map(customerView)
      const text = JSON.stringify(shown)
      for (const n of ENV_NAMES) expect(text, n).not.toContain(n)
      expect(text).not.toMatch(/missingEnv/)
      expect(shown.find(i => i.key === 'quickbooks')).toMatchObject({ status: 'not_configured', detail: 'Not available in this deployment yet.' })
      expect(scrubEnvNames('Stripe is not configured (STRIPE_SECRET_KEY); CREDENTIALS_ENCRYPTION_KEY is missing')).toBe('Stripe is not configured (a setting); a setting is missing')
      const t = await testIntegration(HB.org, 'quickbooks')
      expect(t).toMatchObject({ status: 'not_configured', message: 'QuickBooks Online is not available in this deployment yet.', results: [] })
    })
    // an error message that carries a variable name is scrubbed for the customer
    const m = await realMailbox(HB.org, 'microsoft', 'three@integrations.example')
    await admin(db => saveHealthState(db, { orgId: HB.org, integration: 'microsoft', connectionId: m.id, status: 'error', failures: 3, nextProbeAt: new Date(), checkedAt: new Date(), ok: false, code: 'error', message: 'MICROSOFT_OAUTH_CLIENT_SECRET was rejected' }))
    expect(JSON.stringify(customerView(await statusFor(HB.org, 'microsoft')))).not.toMatch(/MICROSOFT_OAUTH/)
  })

  it('organizations are isolated: status, test, reconnect and disconnect only see their own connections', async () => {
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    await resetOffice(NW)
    const theirs = await connectSyntheticOffice(nw, 'hubspot', { demoData: false })
    expect((await statusFor(HB.org, 'hubspot')).connections.map(c => c.id)).not.toContain(theirs.id)
    expect((await testIntegration(HB.org, 'hubspot')).results.map(r => r.connectionId)).not.toContain(theirs.id)
    await expect(reconnectIntegration(hb, 'hubspot', theirs.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(disconnectIntegration(hb, 'hubspot', theirs.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(reconnectIntegration(await staffActor(), 'hubspot', theirs.id)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await admin(db => db.one('select status from office_connections where id = $1', [theirs.id]))).toEqual({ status: 'active' })
    await resetOffice(NW, { enable: false })
  })

  it('the API answers the signed-in organization only and never names environment variables', async () => {
    const session = { uid: (await merchantActor(HB) as { session: { uid: string } }).session.uid, email: HB.email, role: 'client', agencyId: HB.org, orgType: 'merchant', orgRole: 'owner' }
    vi.resetModules()
    vi.doMock('../../lib/auth', async () => ({ ...(await vi.importActual<object>('../../lib/auth')), getSession: async () => session }))
    try {
      const { GET } = await import('../../app/api/store/integrations/route')
      const res = await withEnv(none, () => GET(new Request('http://localhost/api/store/integrations')))
      expect(res.status).toBe(200)
      const body = await res.json() as { integrations: { key: string; connections: { id: string }[] }[] }
      const text = JSON.stringify(body)
      for (const n of ENV_NAMES) expect(text, n).not.toContain(n)
      expect(body.integrations.find(i => i.key === 'shopify')!.connections.map(c => c.id)).toEqual([HB.conn])
      expect(text).not.toContain(NW.conn)
    } finally { vi.doUnmock('../../lib/auth'); vi.resetModules() }
  })
})
