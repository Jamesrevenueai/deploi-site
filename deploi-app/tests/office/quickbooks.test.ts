import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { admin } from '../../lib/db'
import { prepareDb } from '../db/helpers'
import { startOfficeConnect, completeOfficeConnect, setOfficeExchanger, disconnectOffice, connectSyntheticOffice, OfficeNotConfigured } from '../../lib/office/connections'
import { loadOfficeTokens, officeAccessToken, OfficeAuthError } from '../../lib/office/credentials'
import { setOfficeFetch } from '../../lib/office/http'
import { officeError } from '../../lib/office/request'
import { openCase } from '../../lib/cases'
import { intuitSignature, handleQuickBooksWebhook } from '../../lib/office/quickbooks-webhook'
import { officeReceivablesDetector } from '../../lib/discovery/detectors/office-receivables'
import { listDetectors } from '../../lib/discovery/registry'
import { mutateQboSynth } from '../../lib/office/quickbooks-synthetic'
import { connectSyntheticMailbox } from '../../lib/office/mailbox'
import { staffActor } from '../merchant/helpers'
import { NW, HB, merchantActor } from './helpers'
import { resetReceivables } from './receivables-helpers'

const ready = await prepareDb()
afterAll(async () => { if (ready) { await resetReceivables(NW, { enable: false }); await resetReceivables(HB, { enable: false }) } })
const ENV = { QUICKBOOKS_CLIENT_ID: 'test-qbo-client', QUICKBOOKS_CLIENT_SECRET: 'test-qbo-secret', APP_URL: 'https://app.example' }
const configure = () => Object.assign(process.env, ENV)
const REALM = '4620816365000000001'

type Call = { url: URL; method: string; headers: Headers; body: string }
const calls: Call[] = []
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
/** a fake Intuit: token endpoint (exchange + rotating refresh), revoke, companyinfo */
function fakeIntuit(o: { refresh?: 'ok' | 'invalid_grant' } = {}) {
  let n = 0
  setOfficeFetch(async (url, init) => {
    const c = { url: new URL(url), method: String(init.method ?? 'GET'), headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : '' }
    calls.push(c)
    if (c.url.href === 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer') {
      const f = new URLSearchParams(c.body)
      if (f.get('grant_type') === 'authorization_code') return json(200, { access_token: 'qbo-access-PLAINTEXT', refresh_token: 'qbo-refresh-PLAINTEXT-1', expires_in: 3600, x_refresh_token_expires_in: 8726400, token_type: 'bearer' })
      if (o.refresh === 'invalid_grant') return json(400, { error: 'invalid_grant' })
      n++
      return json(200, { access_token: `qbo-access-${n + 1}`, refresh_token: `qbo-refresh-PLAINTEXT-${n + 1}`, expires_in: 3600, token_type: 'bearer' })
    }
    if (c.url.href === 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke') return new Response('', { status: 200 })
    if (c.url.pathname === `/v3/company/${REALM}/companyinfo/${REALM}`) return json(200, { CompanyInfo: { CompanyName: 'Brightpath Studio LLC' } })
    return json(404, {})
  })
}

describe.skipIf(!ready)('QuickBooks connection: OAuth state, realm binding, encrypted rotating tokens, revoke', () => {
  beforeEach(async () => { await resetReceivables(NW); await resetReceivables(HB); calls.length = 0 })
  afterEach(() => { for (const k of Object.keys(ENV)) delete process.env[k]; setOfficeFetch(null); setOfficeExchanger(null); delete process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN })

  it('without QUICKBOOKS_CLIENT_ID / SECRET connecting answers 503 needs_setup', async () => {
    const e = await startOfficeConnect(await merchantActor(NW), 'quickbooks').catch(x => x)
    expect(e).toBeInstanceOf(OfficeNotConfigured)
    const res = officeError(e)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'needs_setup' })
  })

  it('the consent URL asks for the accounting scope only, with a one-time state bound to the organization and user', async () => {
    configure()
    const nw = await merchantActor(NW), hb = await merchantActor(HB)
    const a = await startOfficeConnect(nw, 'quickbooks')
    const u = new URL(a.url)
    expect(`${u.origin}${u.pathname}`).toBe('https://appcenter.intuit.com/connect/oauth2')
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: 'test-qbo-client', response_type: 'code', scope: 'com.intuit.quickbooks.accounting', redirect_uri: 'https://app.example/api/office/oauth/quickbooks/callback', state: a.state })
    fakeIntuit()
    // another organization cannot use it, and the attempt burns it
    await expect(completeOfficeConnect(hb, { provider: 'quickbooks', state: a.state, code: 'c1', error: null, realmId: REALM })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(completeOfficeConnect(nw, { provider: 'quickbooks', state: a.state, code: 'c1', error: null, realmId: REALM })).rejects.toMatchObject({ code: 'expired' })
    // the callback must carry a numeric company id
    const b = await startOfficeConnect(nw, 'quickbooks')
    await expect(completeOfficeConnect(nw, { provider: 'quickbooks', state: b.state, code: 'c2', error: null, realmId: null })).rejects.toMatchObject({ code: 'invalid_input' })
    const b2 = await startOfficeConnect(nw, 'quickbooks')
    await expect(completeOfficeConnect(nw, { provider: 'quickbooks', state: b2.state, code: 'c2', error: null, realmId: '123/../456' })).rejects.toMatchObject({ code: 'invalid_input' })
    // expired after ten minutes; consent refused connects nothing
    const old = await startOfficeConnect(nw, 'quickbooks', { now: new Date(Date.now() - 11 * 60e3) })
    await expect(completeOfficeConnect(nw, { provider: 'quickbooks', state: old.state, code: 'c3', error: null, realmId: REALM })).rejects.toMatchObject({ code: 'expired' })
    const d = await startOfficeConnect(nw, 'quickbooks')
    await expect(completeOfficeConnect(nw, { provider: 'quickbooks', state: d.state, code: null, error: 'access_denied', realmId: REALM })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(calls).toHaveLength(0) // no code was exchanged for any refused attempt
    await expect(startOfficeConnect(await staffActor(), 'quickbooks')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('exchanges the code (Basic auth, form body), binds the connection to the realm and reads the company with the new token; tokens are encrypted', async () => {
    configure(); fakeIntuit()
    const nw = await merchantActor(NW)
    const a = await startOfficeConnect(nw, 'quickbooks')
    const conn = await completeOfficeConnect(nw, { provider: 'quickbooks', state: a.state, code: 'auth-code-1', error: null, realmId: REALM })
    expect(conn).toMatchObject({ provider: 'quickbooks', external_account_id: REALM, display_name: 'Brightpath Studio LLC', is_synthetic: false, status: 'active', scopes: ['com.intuit.quickbooks.accounting'] })
    const tok = calls[0]
    expect(tok.method).toBe('POST')
    expect(tok.headers.get('authorization')).toBe(`Basic ${Buffer.from('test-qbo-client:test-qbo-secret').toString('base64')}`)
    expect(tok.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(tok.body))).toEqual({ grant_type: 'authorization_code', code: 'auth-code-1', redirect_uri: 'https://app.example/api/office/oauth/quickbooks/callback' })
    expect(calls[1].url.pathname).toBe(`/v3/company/${REALM}/companyinfo/${REALM}`)
    expect(calls[1].headers.get('authorization')).toBe('Bearer qbo-access-PLAINTEXT')
    const raw = await admin(db => db.one('select ciphertext, refresh_ciphertext from office_credentials where connection_id = $1', [conn.id]))
    expect(JSON.stringify(raw)).not.toMatch(/PLAINTEXT/)
    expect(await officeAccessToken(conn.id)).toBe('qbo-access-PLAINTEXT')
    // the connection is bound to its company: another realm is refused while it is connected; the same one reconnects
    const other = await startOfficeConnect(nw, 'quickbooks')
    await expect(completeOfficeConnect(nw, { provider: 'quickbooks', state: other.state, code: 'c', error: null, realmId: '999' })).rejects.toThrow()
    const same = await startOfficeConnect(nw, 'quickbooks')
    expect((await completeOfficeConnect(nw, { provider: 'quickbooks', state: same.state, code: 'c', error: null, realmId: REALM })).id).toBe(conn.id)
    // an exchanger that returns a different company than the callback named is refused
    setOfficeExchanger(async () => ({ tokens: { accessToken: 'x', refreshToken: 'y', expiresIn: 60, scopes: ['com.intuit.quickbooks.accounting'] }, externalId: '777', displayName: null }))
    const hb = await merchantActor(HB)
    const h = await startOfficeConnect(hb, 'quickbooks')
    await expect(completeOfficeConnect(hb, { provider: 'quickbooks', state: h.state, code: 'c', error: null, realmId: REALM })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('refreshes under the lock shortly before expiry, stores the rotated refresh token, and marks the connection on a refused refresh', async () => {
    configure(); fakeIntuit()
    const nw = await merchantActor(NW)
    const a = await startOfficeConnect(nw, 'quickbooks')
    const conn = await completeOfficeConnect(nw, { provider: 'quickbooks', state: a.state, code: 'c', error: null, realmId: REALM })
    calls.length = 0
    await admin(db => db.query(`update office_credentials set expires_at = now() + interval '1 minute' where connection_id = $1`, [conn.id]))
    const [t1, t2] = await Promise.all([officeAccessToken(conn.id), officeAccessToken(conn.id)])
    expect(t1).toBe('qbo-access-2')
    expect(t2).toBe('qbo-access-2')
    expect(calls).toHaveLength(1) // one refresh, the other caller waited for the lock and used the new token
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({ grant_type: 'refresh_token', refresh_token: 'qbo-refresh-PLAINTEXT-1' })
    expect((await admin(db => loadOfficeTokens(db, conn.id)))!.refreshToken).toBe('qbo-refresh-PLAINTEXT-2') // rotated
    // the next refresh sends the rotated token
    await admin(db => db.query(`update office_credentials set expires_at = now() where connection_id = $1`, [conn.id]))
    expect(await officeAccessToken(conn.id)).toBe('qbo-access-3')
    expect(new URLSearchParams(calls[1].body).get('refresh_token')).toBe('qbo-refresh-PLAINTEXT-2')
    // Intuit refuses the refresh token (revoked, expired after 100 days): reconnect needed
    fakeIntuit({ refresh: 'invalid_grant' })
    await admin(db => db.query(`update office_credentials set expires_at = now() where connection_id = $1`, [conn.id]))
    await expect(officeAccessToken(conn.id)).rejects.toBeInstanceOf(OfficeAuthError)
    expect((await admin(db => db.one<{ status: string }>('select status from office_connections where id = $1', [conn.id])))!.status).toBe('needs_reauth')
  })

  it('disconnect revokes the grant at Intuit, deletes the credential and cancels unsent reminders', async () => {
    configure(); fakeIntuit()
    const nw = await merchantActor(NW)
    const a = await startOfficeConnect(nw, 'quickbooks')
    const conn = await completeOfficeConnect(nw, { provider: 'quickbooks', state: a.state, code: 'c', error: null, realmId: REALM })
    await expect(disconnectOffice(await merchantActor(HB), conn.id)).rejects.toMatchObject({ code: 'not_found' })
    calls.length = 0
    const r = await disconnectOffice(nw, conn.id)
    expect(r).toMatchObject({ credentialDeleted: true, revokedAtProvider: true })
    expect(calls[0].url.href).toBe('https://developer.api.intuit.com/v2/oauth2/tokens/revoke')
    expect(JSON.parse(calls[0].body)).toEqual({ token: 'qbo-refresh-PLAINTEXT-1' })
    expect(calls[0].headers.get('authorization')).toMatch(/^Basic /)
    expect(await admin(db => db.one('select 1 from office_credentials where connection_id = $1', [conn.id]))).toBeNull()
  })

  it('webhook: needs its verifier token, refuses a bad signature, and makes only the matching organization\'s case due for a fresh read', async () => {
    configure(); fakeIntuit()
    const nw = await merchantActor(NW)
    const a = await startOfficeConnect(nw, 'quickbooks')
    await completeOfficeConnect(nw, { provider: 'quickbooks', state: a.state, code: 'c', error: null, realmId: REALM })
    const later = new Date(Date.now() + 5 * 864e5)
    const mk = (org: string) => admin(db => openCase(db, { orgId: org, suite: 'office', kind: 'invoice_overdue', sourceApp: 'quickbooks', dedupeKey: `quickbooks:${REALM}:invoice:130:overdue`, title: 'Invoice 130 overdue', problem: 'x',
      verification: { criteria: 'balance 0', rule: { realmId: REALM, invoiceId: '130' } }, records: [{ type: 'qbo_invoice', id: `${REALM}:130` }], nextCheckAt: later, actor: 'test' }))
    const mine = (await mk(NW.org)).case, theirs = (await mk(HB.org)).case // Harbor has no connection to this company
    const body = JSON.stringify({ eventNotifications: [{ realmId: REALM, dataChangeEvent: { entities: [{ name: 'Invoice', id: '130', operation: 'Update' }] } }] })
    expect((await handleQuickBooksWebhook(body, 'x')).status).toBe(503)
    process.env.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN = 'verifier-1'
    expect((await handleQuickBooksWebhook(body, intuitSignature(body, 'wrong'))).status).toBe(401)
    const ok = await handleQuickBooksWebhook(body, intuitSignature(body, 'verifier-1'))
    expect(ok).toMatchObject({ status: 200, body: { ok: true, changes: 1, targeted: 1 } })
    const due = await admin(db => db.query<{ id: string; next_check_at: string }>('select id, next_check_at from cases where id = any($1)', [[mine.id, theirs.id]]))
    expect(new Date(due.find(d => d.id === mine.id)!.next_check_at).getTime()).toBeLessThanOrEqual(Date.now())
    expect(new Date(due.find(d => d.id === theirs.id)!.next_check_at).getTime()).toBe(later.getTime())
    expect(await admin(db => db.query(`select id from jobs where kind = 'case.check' and payload->>'caseId' = $1`, [mine.id]))).toHaveLength(1)
  })
})

describe.skipIf(!ready)('Discovery: overdue invoices detector', () => {
  beforeEach(async () => { await resetReceivables(NW); await resetReceivables(HB) })
  it('counts overdue invoices and their total from QuickBooks and recommends the Accounts Receivable agent', async () => {
    expect(listDetectors().some(d => d.key === 'office-receivables' && d.sourceApp === 'quickbooks' && d.suite === 'office')).toBe(true)
    const actor = await merchantActor(NW)
    expect(await admin(db => officeReceivablesDetector.available(db, NW.org))).toBe(false)
    const qb = await connectSyntheticOffice(actor, 'quickbooks') // demo data: 1037 overdue, 1041 overdue without billing email, 1046 not due
    expect(await admin(db => officeReceivablesDetector.available(db, NW.org))).toBe(true)
    let r = await officeReceivablesDetector.detect({ orgId: NW.org, now: new Date() })
    expect(r.findings.map(f => f.dedupeKey)).toEqual(['quickbooks:synthetic-realm:invoice:1037:overdue'])
    expect(r.findings[0]).toMatchObject({ kind: 'invoice_overdue', records: [{ type: 'qbo_invoice', id: 'synthetic-realm:1037' }] })
    expect(r.findings[0].evidence[0].source).toBe('quickbooks')
    expect(r.recommendation).toMatchObject({ template: 'accounts_receivable', suite: 'office', needs: ['a mailbox to send reminders from', 'the name reminders are signed with'] })
    expect(r.recommendation!.reason).toBe('1 invoice in QuickBooks is 7+ days past due, USD 1,250.00 open in total')
    expect(r.notes!.join(' ')).toMatch(/1 overdue invoice has no billing email/)
    expect(r.sourcesRead).toEqual(['quickbooks:synthetic-realm:invoices'])
    await connectSyntheticMailbox(actor, 'ar@northwind-office.example')
    await mutateQboSynth(qb.id, s => { s.invoices.find(i => i.id === '1041')!.billEmail = 'ap@harborline.example' })
    r = await officeReceivablesDetector.detect({ orgId: NW.org, now: new Date() })
    expect(r.findings).toHaveLength(2)
    expect(r.recommendation!.reason).toBe('2 invoices in QuickBooks are 7+ days past due, USD 1,730.00 open in total')
    expect(r.recommendation!.needs).toEqual(['the name reminders are signed with'])
    // other organizations see nothing; Office disabled: not available
    expect(await admin(db => officeReceivablesDetector.available(db, HB.org))).toBe(false)
    await admin(db => db.query(`update org_products set status = 'disabled' where org_id = $1 and product = 'office'`, [NW.org]))
    expect(await admin(db => officeReceivablesDetector.available(db, NW.org))).toBe(false)
  })
})
