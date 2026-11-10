/**
 * System email (lib/email/system.ts) against a fake Resend that records every request: the EMAIL_LIVE_SENDS
 * gate (off holds, allowlist only to test recipients, all sends), no key holds, one send per idempotency key,
 * escaping, the sender address, and the stored copy with single-use links removed.
 */
import '../merchant/env'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import { setEmailFetch } from '../../lib/email/adapters/http'
import { sendSystemEmail, renderSystemEmail, registerSystemTemplate, systemFromAddress, escapeHtml, RESEND_EMAILS_URL } from '../../lib/email/system'

const ready = await prepareDb()
type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> }
const sent: Sent[] = []
let respond: () => Response = () => new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 })

function fakeResend() {
  sent.length = 0
  respond = () => new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 })
  setEmailFetch(async (url, init) => {
    if (url !== RESEND_EMAILS_URL || init.method !== 'POST') throw new Error(`unexpected HTTP call in test: ${init.method} ${url}`)
    sent.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()), body: JSON.parse(String(init.body)) })
    return respond()
  })
}
const ENV = ['RESEND_API_KEY', 'EMAIL_LIVE_SENDS', 'EMAIL_TEST_RECIPIENTS', 'SYSTEM_MAIL_DOMAIN', 'NEXT_PUBLIC_SITE_URL']
const key = (t: string) => `test:${t}:${Date.now()}:${Math.random().toString(16).slice(2)}`
const row = (id: string) => admin(db => db.one<{ status: string; status_reason: string | null; to_address: string; from_address: string; subject: string; body_text: string; body_html: string; attempts: number; provider_message_id: string | null }>('select * from system_emails where id = $1', [id]))

registerSystemTemplate('test_note', p => ({ subject: `Note for ${p.name}\r\nBcc: evil@example.com`, text: `Hello ${p.name}. Link: ${p.link}`, html: `<p>Hello ${escapeHtml(p.name)}. <a href="${escapeHtml(p.link)}">open</a></p>` }))

describe.skipIf(!ready)('system mailer', () => {
  beforeEach(() => { fakeResend(); process.env.RESEND_API_KEY = 're_test_key' })
  afterEach(async () => {
    setEmailFetch(null)
    for (const k of ENV) delete process.env[k]
    await admin(db => db.query(`delete from system_emails where idempotency_key like 'test:%'`))
  })

  it('EMAIL_LIVE_SENDS off (the default): the message is recorded as held and nothing reaches Resend', async () => {
    const r = await sendSystemEmail({ key: key('off'), template: 'test_note', to: 'pat@example.com', params: { name: 'Pat', link: 'https://x.test/a' } })
    expect(r.status).toBe('held')
    expect(r.reason).toMatch(/EMAIL_LIVE_SENDS/)
    expect(sent).toHaveLength(0)
    expect(await row(r.id)).toMatchObject({ status: 'held', to_address: 'pat@example.com', attempts: 0 })
  })

  it('without RESEND_API_KEY every message is held, whatever the gate says', async () => {
    delete process.env.RESEND_API_KEY
    process.env.EMAIL_LIVE_SENDS = 'all'
    const r = await sendSystemEmail({ key: key('nokey'), template: 'test_note', to: 'pat@example.com', params: { name: 'Pat', link: 'x' } })
    expect(r).toMatchObject({ status: 'held' })
    expect(r.reason).toMatch(/RESEND_API_KEY/)
    expect(sent).toHaveLength(0)
  })

  it('allowlist: only EMAIL_TEST_RECIPIENTS (addresses or @domains) are sent to; everyone else is held', async () => {
    process.env.EMAIL_LIVE_SENDS = 'allowlist'
    process.env.EMAIL_TEST_RECIPIENTS = 'me@owner.example,@team.example'
    const a = await sendSystemEmail({ key: key('al1'), template: 'test_note', to: 'me@owner.example', params: { name: 'Me', link: 'x' } })
    const b = await sendSystemEmail({ key: key('al2'), template: 'test_note', to: 'anyone@team.example', params: { name: 'T', link: 'x' } })
    const c = await sendSystemEmail({ key: key('al3'), template: 'test_note', to: 'stranger@elsewhere.example', params: { name: 'S', link: 'x' } })
    expect([a.status, b.status, c.status]).toEqual(['sent', 'sent', 'held'])
    expect(c.reason).toMatch(/only test recipients/)
    expect(sent.map(s => s.body.to)).toEqual([['me@owner.example'], ['anyone@team.example']])
  })

  it('all: sent from support@<site domain> through Resend with an idempotency key; a repeat with the same key never sends twice', async () => {
    process.env.EMAIL_LIVE_SENDS = 'all'
    process.env.NEXT_PUBLIC_SITE_URL = 'https://www.getdeploi.com'
    expect(systemFromAddress()).toBe('hello@getdeploi.com')
    const k = key('all')
    const r = await sendSystemEmail({ key: k, template: 'test_note', to: 'Pat@Example.com', params: { name: 'Pat', link: 'https://app.test/i/1' } })
    expect(r).toMatchObject({ status: 'sent', duplicate: false })
    expect(sent).toHaveLength(1)
    expect(sent[0].headers.authorization).toBe('Bearer re_test_key')
    expect(sent[0].headers['idempotency-key']).toMatch(/^deploi-system-[0-9a-f]{48}$/)
    expect(sent[0].body).toMatchObject({ from: 'Deploi <support@getdeploi.com>', to: ['pat@example.com'] })
    // a header injection in the subject is flattened onto one line
    expect(sent[0].body.subject).toBe('Note for Pat Bcc: evil@example.com')
    const again = await sendSystemEmail({ key: k, template: 'test_note', to: 'pat@example.com', params: { name: 'Pat', link: 'https://app.test/i/1' } })
    expect(again).toMatchObject({ id: r.id, status: 'sent', duplicate: true })
    expect(sent).toHaveLength(1)
    expect(await row(r.id)).toMatchObject({ status: 'sent', provider_message_id: 're_1', attempts: 1 })
    process.env.SYSTEM_MAIL_DOMAIN = 'mail.getdeploi.test'
    expect(systemFromAddress()).toBe('hello@mail.getdeploi.test')
  })

  it('a refused send is recorded as failed and retried under the same key; a lost response is "uncertain" and not resent', async () => {
    process.env.EMAIL_LIVE_SENDS = 'all'
    respond = () => new Response(JSON.stringify({ message: 'domain not verified' }), { status: 422 })
    const k = key('fail')
    const r = await sendSystemEmail({ key: k, template: 'test_note', to: 'pat@example.com', params: { name: 'Pat', link: 'x' } })
    expect(r.status).toBe('failed')
    respond = () => new Response(JSON.stringify({ id: 're_ok' }), { status: 200 })
    const retry = await sendSystemEmail({ key: k, template: 'test_note', to: 'pat@example.com', params: { name: 'Pat', link: 'x' } })
    expect(retry).toMatchObject({ id: r.id, status: 'sent' })
    expect(sent[0].headers['idempotency-key']).toBe(sent[1].headers['idempotency-key'])
    respond = () => new Response('oops', { status: 503 })
    const k2 = key('unc')
    expect((await sendSystemEmail({ key: k2, template: 'test_note', to: 'pat@example.com', params: { name: 'Pat', link: 'x' } })).status).toBe('uncertain')
    const n = sent.length
    expect((await sendSystemEmail({ key: k2, template: 'test_note', to: 'pat@example.com', params: { name: 'Pat', link: 'x' } })).duplicate).toBe(true)
    expect(sent.length).toBe(n)
  })

  it('values are escaped in HTML, and secret params (single-use links) are removed from the stored copy only', async () => {
    process.env.EMAIL_LIVE_SENDS = 'all'
    const r = await sendSystemEmail({ key: key('esc'), template: 'member_invite', to: 'new@example.com', secretParams: ['link'],
      params: { inviter: '<script>alert(1)</script>', org: 'Tom & Jerry "Goods"', role: 'admin', roleArticle: 'an', link: 'https://app.test/invite/v1.secret', email: 'new@example.com', expires: '2026-11-12' } })
    const html = String(sent[0].body.html)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('Tom &amp; Jerry &quot;Goods&quot;')
    expect(html).toContain('href="https://app.test/invite/v1.secret"')
    expect(String(sent[0].body.text)).toContain('https://app.test/invite/v1.secret')
    const stored = (await row(r.id))!
    expect(stored.body_text).not.toContain('v1.secret')
    expect(stored.body_html).not.toContain('v1.secret')
    expect(stored.body_text).toContain('[link removed]')
  })

  it('refuses a malformed recipient and an unknown template before recording anything', async () => {
    await expect(sendSystemEmail({ key: key('bad'), template: 'test_note', to: 'a@b.c\r\nBcc: x@y.z', params: { name: 'x', link: 'x' } })).rejects.toThrow(/recipient/)
    expect(() => renderSystemEmail('nope', {})).toThrow(/unknown/)
  })
})
