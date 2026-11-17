/**
 * Reconnection restores a connection IN PLACE: the same id, so the agents and cases that use it keep
 * working; the reason is cleared, the health history records the transition, and agents blocked by the
 * broken connection say why and resume their due work once it is fixed.
 */
import './helpers'
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { reconnectIntegration, statusOf, integrationDef, testIntegration } from '../../lib/integrations/registry'
import { breakSyntheticConnection } from '../../lib/integrations/demo'
import { runOfficeAgent } from '../../lib/office/run'
import { completeOfficeConnect, setOfficeExchanger, startOfficeConnect } from '../../lib/office/connections'
import { setOfficeRefresher } from '../../lib/office/credentials'
import { HUBSPOT_SCOPES } from '../../lib/office/hubspot'
import { completeConnect } from '../../lib/email/accounts'
import { setEmailFetch } from '../../lib/email/adapters/http'
import { connectStore } from '../../lib/connectors/woocommerce/connect'
import { setWooTransportOverride } from '../../lib/connectors/woocommerce/client'
import { controlRoom } from '../../lib/store/control-room'
import { enqueueDueWork } from '../../lib/jobs'
import { NW, HB, setupOffice, grantedAgent as officeAgent, actions, lead, t0, pinClock, resetOffice } from '../office/helpers'
import { grantedAgent as storeAgent, cleanInfra } from '../infra/helpers'
import { resetMerchant } from '../merchant/helpers'
import { realMailbox, realStore, cleanIntegrations, fakeFetch, json } from './helpers'

const ready = await prepareDb()
type HealthRow = { trigger: string; ok: boolean; previous_status: string | null; status: string }
const lastHealth = (id: string) => admin(db => db.one<HealthRow>('select trigger, ok, previous_status, status from connection_health where connection_id = $1 order by checked_at desc, id limit 1', [id]))
const view = (orgId: string, key: Parameters<typeof integrationDef>[0]) => admin(db => statusOf(db, integrationDef(key), orgId))

describe.skipIf(!ready)('reconnect in place', () => {
  beforeEach(async () => { await cleanIntegrations() })
  afterEach(() => { vi.useRealTimers(); setOfficeExchanger(null); setOfficeRefresher(null); setEmailFetch(null); setWooTransportOverride(null) })
  afterAll(async () => {
    if (!ready) return
    await cleanIntegrations(); await cleanInfra()
    await admin(db => db.query(`delete from jobs where kind = 'connection.health'`))
    await resetOffice(NW, { enable: false }); await resetOffice(HB, { enable: false }); await resetMerchant(NW)
  })

  it('Office (synthetic HubSpot): Test finds the refused grant, the agent is blocked with that reason, Reconnect keeps the id and the agent resumes', async () => {
    const T = t0()
    pinClock(T)
    const s = await setupOffice(NW, [lead('801', 'kai@lumen-goods.example', new Date(T.getTime() - 3600e3))])
    const agent = await officeAgent(s, 'lead_followup')
    await breakSyntheticConnection(s.actor, 'hubspot', s.hubspotId)
    const t = await testIntegration(NW.org, 'hubspot')
    expect(t).toMatchObject({ status: 'needs_reauth', results: [{ connectionId: s.hubspotId, ok: false, code: 'auth', previous: 'connected', status: 'needs_reauth' }] })
    expect(await view(NW.org, 'hubspot')).toMatchObject({ status: 'needs_reauth', can: { reconnect: true } })
    // the agent says why it is blocked, and does nothing
    const blocked = await runOfficeAgent(agent, { trigger: 'test', now: T })
    expect(blocked.status).toBe('blocked')
    expect(blocked.reason).toMatch(/^HubSpot needs to be reconnected .*reconnect it on the Integrations page and the agent resumes its waiting work$/)
    expect(await actions(agent)).toHaveLength(0)
    const next = (await admin(db => db.one<{ next_run_at: string }>('select next_run_at from office_agents where id = $1', [agent])))!.next_run_at
    expect(new Date(next).getTime()).toBeGreaterThan(T.getTime())

    const r = await reconnectIntegration(s.actor, 'hubspot', s.hubspotId)
    expect(r).toEqual({ kind: 'done', connectionId: s.hubspotId, message: 'HubSpot is reconnected.' })
    expect(await admin(db => db.one('select id, status, status_reason from office_connections where id = $1', [s.hubspotId]))).toEqual({ id: s.hubspotId, status: 'active', status_reason: null })
    expect(await lastHealth(s.hubspotId)).toEqual({ trigger: 'reconnect', ok: true, previous_status: 'needs_reauth', status: 'connected' })
    expect(await view(NW.org, 'hubspot')).toMatchObject({ status: 'connected', lastError: null, connections: [{ id: s.hubspotId, consecutiveFailures: 0, reason: null }] })
    // due at once, and the waiting work runs on the same connection
    const resumed = (await admin(db => db.one<{ next_run_at: string }>('select next_run_at from office_agents where id = $1', [agent])))!.next_run_at
    expect(new Date(resumed).getTime()).toBeLessThanOrEqual(Date.now())
    const again = await runOfficeAgent(agent, { trigger: 'schedule', now: new Date(T.getTime() + 60e3) })
    expect(again.status).toBe('completed')
    expect((await actions(agent)).map(a => a.payload.to)).toEqual(['kai@lumen-goods.example'])
  })

  it('Office (HubSpot OAuth): a refused refresh needs reauth; Reconnect starts consent and the same row comes back', async () => {
    for (const k of ['HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET']) process.env[k] = `test-${k.toLowerCase()}`
    try {
      await resetOffice(HB)
      const actor = (await setupOffice(HB)).actor
      await admin(db => db.query(`delete from office_connections where org_id = $1 and provider = 'hubspot'`, [HB.org]))
      setOfficeExchanger(async () => ({ tokens: { accessToken: 'a1', refreshToken: 'r1', expiresIn: 1800, scopes: [...HUBSPOT_SCOPES] }, externalId: '4711', displayName: 'Portal 4711' }))
      const first = await startOfficeConnect(actor, 'hubspot')
      const row = await completeOfficeConnect(actor, { provider: 'hubspot', state: first.state, code: 'c1', error: null })
      // the access token expires and HubSpot refuses the refresh token
      await admin(db => db.query(`update office_credentials set expires_at = now() - interval '1 minute' where connection_id = $1`, [row.id]))
      setOfficeRefresher(async () => { throw Object.assign(new Error('refused'), { auth: true }) })
      expect(await testIntegration(HB.org, 'hubspot')).toMatchObject({ status: 'needs_reauth', results: [{ code: 'auth' }] })
      const r = await reconnectIntegration(actor, 'hubspot', row.id)
      expect(r.kind).toBe('redirect')
      const url = new URL((r as { url: string }).url)
      expect(url.origin + url.pathname).toBe('https://app.hubspot.com/oauth/authorize')
      expect(url.searchParams.get('scope')).toBe(HUBSPOT_SCOPES.join(' '))
      setOfficeExchanger(async () => ({ tokens: { accessToken: 'a2', refreshToken: 'r2', expiresIn: 1800, scopes: [...HUBSPOT_SCOPES] }, externalId: '4711', displayName: 'Portal 4711' }))
      const back = await completeOfficeConnect(actor, { provider: 'hubspot', state: url.searchParams.get('state')!, code: 'c2', error: null })
      expect(back.id).toBe(row.id)
      expect(await admin(db => db.one('select status, status_reason from office_connections where id = $1', [row.id]))).toEqual({ status: 'active', status_reason: null })
      expect(await lastHealth(row.id)).toMatchObject({ trigger: 'reconnect', previous_status: 'needs_reauth', status: 'connected' })
    } finally { for (const k of ['HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET']) delete process.env[k] }
  })

  it('Store (Shopify): an agent on a store that needs renewing is not queued and shows why; after Reconnect (same id) its due run is queued', async () => {
    await resetMerchant(NW)
    const actor = (await setupOffice(NW)).actor
    const agent = await storeAgent(actor, NW, 'Stock guard')
    await admin(db => db.query(`update agents set next_run_at = now() - interval '5 minutes' where id = $1`, [agent]))
    await admin(db => db.query(`update store_connections set status = 'error', status_reason = 'needs_reauth: refresh refused (HTTP 401)', reauth_required_at = now() where id = $1`, [NW.conn]))
    const queued = async () => (await admin(db => db.query<{ id: string }>(`select id from jobs where kind = 'agent.run' and agent_id = $1`, [agent]))).length
    await enqueueDueWork()
    expect(await queued()).toBe(0)
    const cr = await controlRoom(actor)
    expect(cr.agents.find(a => a.id === agent)).toMatchObject({ health: 'needs_attention' })
    expect(cr.agents.find(a => a.id === agent)!.attention[0]).toBe('Shopify needs to be reconnected (refresh refused (HTTP 401)); the agent resumes once it is reconnected on the Integrations page')

    const r = await reconnectIntegration(actor, 'shopify', NW.conn)
    expect(r).toEqual({ kind: 'done', connectionId: NW.conn, message: 'Shopify is reconnected.' })
    expect(await admin(db => db.one('select status, status_reason from store_connections where id = $1', [NW.conn]))).toEqual({ status: 'active', status_reason: null })
    expect(await lastHealth(NW.conn)).toMatchObject({ trigger: 'reconnect', previous_status: 'needs_reauth', status: 'connected' })
    await enqueueDueWork()
    expect(await queued()).toBe(1)
    expect((await controlRoom(actor)).agents.find(a => a.id === agent)!.attention).toEqual([])
  })

  it('WooCommerce: a refused key is found by Test; approving a new key for the same store keeps the connection id and clears the reason', async () => {
    const site = 'https://keys-probe.store'
    const id = await realStore(HB.org, 'woocommerce', site)
    let refuse = true
    setWooTransportOverride(() => async () => refuse ? { status: 401, headers: {}, body: JSON.stringify({ code: 'woocommerce_rest_authentication_error', message: 'Invalid signature' }) } : { status: 200, headers: {}, body: JSON.stringify({ environment: { version: '8.9.1' } }) })
    expect(await testIntegration(HB.org, 'woocommerce')).toMatchObject({ status: 'needs_reauth', results: [{ connectionId: id, code: 'auth' }] })
    expect(await admin(db => db.one('select status, status_reason from store_connections where id = $1', [id]))).toMatchObject({ status: 'error', status_reason: expect.stringMatching(/^needs_reauth: /) })
    refuse = false
    const transport = async (req: { url: string }) => {
      const p = new URL(req.url).pathname
      if (p.endsWith('/system_status')) return { status: 200, headers: {}, body: JSON.stringify({ environment: { version: '8.9.1', wp_version: '6.6' } }) }
      if (p.endsWith('/woocommerce_currency')) return { status: 200, headers: {}, body: JSON.stringify({ id: 'woocommerce_currency', value: 'USD' }) }
      if (p === '/wp-json/') return { status: 200, headers: {}, body: JSON.stringify({ name: 'Keys Store', timezone_string: 'America/New_York' }) }
      return { status: 404, headers: {}, body: JSON.stringify({ code: 'rest_no_route' }) }
    }
    const r = await connectStore({ orgId: HB.org, actor: 'user:owner@harbor-supply.example', siteUrl: site, creds: { consumerKey: 'ck_' + 'c'.repeat(40), consumerSecret: 'cs_' + 'd'.repeat(40) }, permissions: 'read_write', via: 'manual' }, { transport })
    expect(r).toMatchObject({ connectionId: id, created: false })
    expect(await admin(db => db.one('select status, status_reason, reauth_required_at from store_connections where id = $1', [id]))).toEqual({ status: 'active', status_reason: null, reauth_required_at: null })
    expect(await lastHealth(id)).toMatchObject({ trigger: 'reconnect', previous_status: 'needs_reauth', status: 'connected' })
    expect((await view(HB.org, 'woocommerce')).status).toBe('connected')
  })

  it('Gmail: Reconnect starts consent for the same account (login hint); completing it keeps the account id', async () => {
    const env = { EMAIL_OAUTH_PROVIDERS: 'on', GOOGLE_OAUTH_CLIENT_ID: 'gid', GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret' }
    Object.assign(process.env, env)
    try {
      const { actor } = await setupOffice(HB)
      const acc = await realMailbox(HB.org, 'gmail', 'owner@integrations.example')
      await admin(db => db.query(`update email_accounts set status = 'needs_reauth', status_reason = 'reconnect the account' where id = $1`, [acc.id]))
      const r = await reconnectIntegration(actor, 'gmail', acc.id)
      const url = new URL((r as { url: string }).url)
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
      expect(url.searchParams.get('login_hint')).toBe('owner@integrations.example')
      setEmailFetch(fakeFetch(u => u === 'https://oauth2.googleapis.com/token' ? json(200, { access_token: 'ya29.new', refresh_token: '1//new', expires_in: 3599, scope: 'openid email profile https://www.googleapis.com/auth/gmail.send', token_type: 'Bearer' })
        : u.startsWith('https://openidconnect.googleapis.com/v1/userinfo') ? json(200, { email: 'owner@integrations.example', name: 'Owner' }) : json(404, {})).fetch)
      const done = await completeConnect(actor, { state: url.searchParams.get('state')!, code: 'auth-code', error: null })
      expect(done.account).toMatchObject({ id: acc.id, status: 'active', status_reason: null })
      expect(await lastHealth(acc.id)).toMatchObject({ trigger: 'reconnect', previous_status: 'needs_reauth', status: 'connected' })
    } finally { for (const k of Object.keys(env)) delete process.env[k] }
  })
})
