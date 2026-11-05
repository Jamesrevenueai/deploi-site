/**
 * Inbox readers against fake Gmail and Graph HTTP layers (documented response shapes; no network):
 * pagination, expired cursors (Gmail history 404, Graph delta 410), labels and folders, safe MIME parsing
 * (malformed, huge, odd charsets, attachments as metadata), error mapping, and push verification.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { setEmailFetch } from '../../lib/email/adapters/http'
import { gmailRead } from '../../lib/email/readers/gmail'
import { graphRead } from '../../lib/email/readers/microsoft'
import { ReadError } from '../../lib/email/readers/http'
import { MAX_TEXT, parseAddressList, parseAuthResults, parseGmailMessage, parseGraphMessage } from '../../lib/email/readers/parse'
import { authAllPass, authFailures, bulkReason } from '../../lib/email/sender-policy'
import { resetPushKeys, verifyGooglePushToken, GOOGLE_CERTS } from '../../lib/email/push'
import { GOOGLE_AUTH_PASS, MS_AUTH_PASS, gmailFake, graphFake } from '../office/inbox-fakes'
import { microsoftAdapter } from '../../lib/email/adapters/microsoft'
import { gmailAdapter, GMAIL_READ } from '../../lib/email/adapters/gmail'

afterEach(() => setEmailFetch(null))
const T = Date.parse('2026-11-03T13:00:00Z')

describe('Gmail reader (users.history.list, messages.list/get)', () => {
  it('first sync: profile historyId, bounded inbox query, spam and promotions skipped, full bodies, attachments as metadata only', async () => {
    const g = gmailFake()
    g.add({ labelIds: ['INBOX', 'UNREAD'], internalDate: T, headers: { From: 'Kim <kim@client-co.example>', To: g.s.address, Subject: 'Opening hours', 'Message-ID': '<k1@client-co.example>', 'Authentication-Results': GOOGLE_AUTH_PASS }, text: 'What are your hours?', attachments: [{ filename: 'menu.pdf', mimeType: 'application/pdf', size: 52000 }] })
    g.add({ labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'], internalDate: T, headers: { From: 'deals@shop.example', Subject: 'Sale' }, text: 'buy' })
    g.add({ labelIds: ['SPAM'], internalDate: T, headers: { From: 'x@spam.example', Subject: 'win' }, text: 'win' })
    setEmailFetch(g.fetch)
    const r = await gmailRead('tok', null)
    expect(r.full).toBe(true)
    expect(r.cursor).toBe(String(g.s.historyId))
    const list = g.s.calls.find(c => c.url.includes('/messages?'))!
    expect(new URL(list.url).searchParams.get('q')).toBe('newer_than:7d in:inbox -category:promotions')
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0]).toMatchObject({ from: 'kim@client-co.example', subject: 'Opening hours', text: 'What are your hours?', internetMessageId: '<k1@client-co.example>',
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, attachments: [{ filename: 'menu.pdf', contentType: 'application/pdf', size: 52000 }] })
    // attachment content is never requested
    expect(g.s.calls.some(c => c.url.includes('/attachments'))).toBe(false)
    expect(g.s.calls.every(c => c.headers.authorization === 'Bearer tok')).toBe(true)
  })

  it('incremental sync follows every history page; an expired historyId (404) falls back to a bounded full resync', async () => {
    const g = gmailFake()
    setEmailFetch(g.fetch)
    const first = await gmailRead('tok', null)
    for (const n of [1, 2, 3]) g.add({ labelIds: ['INBOX'], internalDate: T + n, headers: { From: `p${n}@client-co.example`, Subject: `m${n}` }, text: `hello ${n}` })
    const inc = await gmailRead('tok', first.cursor)
    expect(inc.full).toBe(false)
    expect(inc.messages.map(m => m.subject)).toEqual(['m1', 'm2', 'm3'])
    expect(g.s.calls.filter(c => c.url.includes('/history?')).length).toBe(3) // nextPageToken followed
    expect(inc.cursor).toBe(String(g.s.historyId))
    g.s.expiredBelow = Number(inc.cursor) + 1
    const resync = await gmailRead('tok', inc.cursor)
    expect(resync.full).toBe(true)
    expect(resync.messages).toHaveLength(3) // the bounded inbox list
  })

  it('a message above the size cap is fetched as metadata only; sent mail marks its thread as answered', async () => {
    const g = gmailFake()
    const big = g.add({ labelIds: ['INBOX'], internalDate: T, sizeEstimate: 30_000_000, headers: { From: 'big@client-co.example', Subject: 'Huge' }, text: 'x'.repeat(10) })
    g.add({ threadId: big.threadId, labelIds: ['SENT'], internalDate: T + 3600e3, headers: { From: g.s.address, To: 'big@client-co.example', Subject: 'Re: Huge' }, text: 'ok' })
    setEmailFetch(g.fetch)
    const r = await gmailRead('tok', null)
    expect(r.messages[0]).toMatchObject({ subject: 'Huge', text: '', truncated: true })
    expect(g.s.calls.some(c => c.url.includes(`/messages/${big.id}?format=full`))).toBe(false)
    expect(r.sent).toEqual([{ threadId: big.threadId, at: new Date(T + 3600e3).toISOString() }])
  })

  it('maps errors: 401 needs reauth, 429 and 403 rateLimitExceeded throttle with Retry-After, 5xx is transient', async () => {
    const g = gmailFake()
    setEmailFetch(g.fetch)
    for (const [fail, kind, retry] of [[{ status: 401 }, 'auth', null], [{ status: 429, headers: { 'retry-after': '30' } }, 'throttled', 30],
      [{ status: 403, body: { error: { code: 403, message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } } }, 'throttled', 120],
      [{ status: 403, body: { error: { code: 403, message: 'Request had insufficient authentication scopes.' } } }, 'auth', null], [{ status: 503 }, 'transient', null]] as const) {
      g.s.fail = fail as typeof g.s.fail
      const e = await gmailRead('tok', '5').catch(x => x)
      expect(e).toBeInstanceOf(ReadError)
      expect(e).toMatchObject({ kind, retryAfterSec: retry })
    }
  })
})

describe('Graph reader (delta query)', () => {
  const msg = (id: string, over: Partial<ReturnType<typeof graphFake>['s']['inbox'][number]> = {}) => ({ id, conversationId: `conv-${id}`, internetMessageId: `<${id}@client-co.example>`, subject: `S ${id}`, from: `${id}@client-co.example`, to: ['owner@harbor-mail.example'],
    receivedDateTime: new Date(T).toISOString(), body: `Body ${id}`, headers: [{ name: 'Authentication-Results', value: MS_AUTH_PASS }], ...over })

  it('follows @odata.nextLink to the @odata.deltaLink, bounded first round, removed items and drafts ignored, headers selected', async () => {
    const f = graphFake()
    f.s.inbox.push(msg('a'), msg('b'), msg('c', { isDraft: true }))
    f.s.removed.push('gone-1')
    setEmailFetch(f.fetch)
    const r = await graphRead('tok', null, null)
    expect(r.full).toBe(true)
    expect(r.cursor).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages\/delta\?\$deltatoken=/)
    const first = new URL(f.s.calls[0].url)
    expect(first.searchParams.get('$filter')).toMatch(/^receivedDateTime ge \d{4}-\d\d-\d\dT/)
    expect(f.s.calls.some(c => c.url.includes('$skiptoken='))).toBe(true)
    expect(r.messages.map(m => m.providerMessageId)).toEqual(['a', 'b'])
    const get = f.s.calls.find(c => c.url.includes('/me/messages/a?'))!
    expect(new URL(get.url).searchParams.get('$select')).toContain('internetMessageHeaders')
    expect(new URL(get.url).searchParams.get('$expand')).toBe('attachments($select=name,contentType,size)')
    expect(get.headers.prefer).toBe('outlook.body-content-type="text"')
    expect(r.messages[0]).toMatchObject({ providerThreadId: 'conv-a', authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } })
    // next round: only what is new
    f.s.inbox.push(msg('d'))
    const next = await graphRead('tok', r.cursor, r.sentCursor ?? null)
    expect(next.messages.map(m => m.providerMessageId)).toEqual(['d'])
    expect(next.full).toBe(false)
  })

  it('410 Gone on an expired delta token starts a new bounded round; foreign links are never followed', async () => {
    const f = graphFake()
    f.s.inbox.push(msg('a'))
    setEmailFetch(f.fetch)
    const r = await graphRead('tok', null, null)
    f.s.expired.add(new URL(r.cursor).searchParams.get('$deltatoken')!)
    const again = await graphRead('tok', r.cursor, null)
    expect(again.full).toBe(true)
    expect(again.messages.map(m => m.providerMessageId)).toEqual(['a'])
    const calls = f.s.calls.length
    await graphRead('tok', 'https://attacker.example/steal?x=1', null)
    expect(f.s.calls.slice(calls).every(c => new URL(c.url).host === 'graph.microsoft.com')).toBe(true)
  })
})

describe('safe parsing', () => {
  it('malformed MIME never throws: bad base64, missing payload, deep nesting, unknown charset, odd addresses', () => {
    expect(parseGmailMessage({}, { bodyFetched: true })).toBeNull()
    expect(parseGmailMessage({ id: 'x' }, { bodyFetched: true })).toMatchObject({ from: '', text: '', subject: '' })
    expect(parseGmailMessage({ id: 'x', payload: { mimeType: 'text/plain', body: { data: '!!!not base64***' }, headers: [{ name: 'From', value: 'a@b.example' }] } }, { bodyFetched: true })!.text).toBe('')
    let deep: Record<string, unknown> = { mimeType: 'text/plain', body: { data: Buffer.from('deep').toString('base64url') } }
    for (let i = 0; i < 40; i++) deep = { mimeType: 'multipart/mixed', parts: [deep] }
    expect(parseGmailMessage({ id: 'x', payload: deep }, { bodyFetched: true })!.text).toBe('') // deeper than the cap: ignored
    const latin = parseGmailMessage({ id: 'y', payload: { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=x-unknown-9' }], body: { data: Buffer.from('café').toString('base64url') } } }, { bodyFetched: true })!
    expect(latin.text).toContain('caf')
    expect(parseAddressList('"Last, First" <c@z.example>, b@y.example; bad-address, <MAILTO:D@X.EXAMPLE>')).toEqual(['c@z.example', 'b@y.example', 'd@x.example'])
    const crlf = parseGmailMessage({ id: 'z', payload: { headers: [{ name: 'Subject', value: 'Hi\r\nBcc: evil@x.example' }, { name: 'From', value: 'a@b.example' }] } }, { bodyFetched: false })!
    expect(crlf.subject).not.toMatch(/[\r\n]/)
  })

  it('huge bodies are cut at the cap and flagged; HTML-only mail becomes text and is never rendered', () => {
    const huge = 'A'.repeat(MAX_TEXT * 3)
    const p = parseGmailMessage({ id: 'h', payload: { mimeType: 'text/plain', body: { data: Buffer.from(huge).toString('base64url') } } }, { bodyFetched: true })!
    expect(p.text.length).toBe(MAX_TEXT)
    expect(p.truncated).toBe(true)
    const g = parseGraphMessage({ id: 'm', from: { emailAddress: { address: 'a@b.example' } }, body: { contentType: 'html', content: '<p>Hello<script>alert(1)</script></p><b>there</b>' } })!
    expect(g.text).toContain('Hello')
    expect(g.text).toContain('there')
    expect(g.text).not.toContain('alert')
  })

  it('authentication results: only the receiving server\'s header counts; a sender-written header below it does not', () => {
    // Gmail: the first header from mx.google.com; a forged one written by the sender is ignored
    expect(parseAuthResults(['evil.example; spf=pass dkim=pass dmarc=pass', 'mx.google.com; spf=fail smtp.mailfrom=x; dkim=none; dmarc=fail'], 'mx.google.com')).toEqual({ spf: 'fail', dmarc: 'fail', dkim: 'none' })
    expect(parseAuthResults(['evil.example; spf=pass dkim=pass dmarc=pass'], 'mx.google.com')).toBeNull()
    const ms = parseGraphMessage({ id: 'm', from: { emailAddress: { address: 'a@b.example' } }, internetMessageHeaders: [{ name: 'Authentication-Results', value: 'spf=softfail smtp.mailfrom=b.example; dkim=none; dmarc=fail action=quarantine' }, { name: 'Authentication-Results', value: 'spf=pass; dkim=pass; dmarc=pass' }] })!
    expect(ms.authentication).toEqual({ spf: 'softfail', dkim: 'none', dmarc: 'fail' })
    expect(authAllPass(ms.authentication)).toBe(false)
    expect(authFailures(ms.authentication)).toEqual(['dmarc'])
    expect(bulkReason({ 'list-unsubscribe': '<https://x.example/u>' })).toBe('List-Unsubscribe')
    expect(bulkReason({ precedence: 'bulk' })).toBe('Precedence: bulk')
    expect(bulkReason({})).toBeNull()
  })
})

describe('Gmail push (Pub/Sub OIDC token)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }
  const token = (claims: Record<string, unknown>, kid = 'k1', key = privateKey) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url'), p = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `Bearer ${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`
  }
  const now = Date.now()
  const good = { iss: 'https://accounts.google.com', aud: 'https://app.example/api/webhooks/gmail-push', email: 'push@proj.iam.gserviceaccount.com', email_verified: true, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600 }
  afterEach(() => { for (const k of ['GMAIL_PUSH_TOPIC', 'GMAIL_PUSH_AUDIENCE', 'GMAIL_PUSH_SERVICE_ACCOUNT']) delete process.env[k]; resetPushKeys() })

  it('accepts only a Google-signed token for the configured audience and service account', async () => {
    expect(await verifyGooglePushToken(token(good), now)).toBe('push is not configured') // off without configuration
    process.env.GMAIL_PUSH_TOPIC = 'projects/p/topics/gmail'; process.env.GMAIL_PUSH_AUDIENCE = good.aud; process.env.GMAIL_PUSH_SERVICE_ACCOUNT = good.email
    let fetched = 0
    setEmailFetch(async url => { expect(url).toBe(GOOGLE_CERTS); fetched++; return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }) })
    expect(await verifyGooglePushToken(token(good), now)).toBeNull()
    expect(await verifyGooglePushToken(token({ ...good, aud: 'https://other.example' }), now)).toBe('wrong audience')
    expect(await verifyGooglePushToken(token({ ...good, email: 'someone@else.example' }), now)).toBe('wrong service account')
    expect(await verifyGooglePushToken(token({ ...good, iss: 'https://evil.example' }), now)).toBe('wrong issuer')
    expect(await verifyGooglePushToken(token({ ...good, exp: Math.floor(now / 1000) - 600 }), now)).toBe('token expired')
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    expect(await verifyGooglePushToken(token(good, 'k1', other), now)).toBe('bad signature')
    expect(await verifyGooglePushToken(null, now)).toBe('missing bearer token')
    expect(fetched).toBe(1) // keys cached
  })
})

describe('replies in the provider thread and the scopes asked for', () => {
  const msg = { internetMessageId: '<x@deploi>', from: 'owner@harbor-mail.example', fromName: null, to: ['kim@client-co.example'], cc: [], content: { subject: 'Re: Order', bodyText: 'Thanks', attachments: [] }, deploiId: 'm1', inReplyTo: '<o1@client-co.example>', references: ['<o1@client-co.example>'], providerReply: { messageId: 'AAMk-o1', threadId: 'conv-o1' } }
  const account = { id: 'a', orgId: 'o', provider: 'microsoft' as const, address: 'owner@harbor-mail.example', scopes: ['Mail.Send', 'Mail.Read'] }
  it('Outlook: /reply with Mail.Send; createReply + PATCH + send with Mail.ReadWrite; recipients set explicitly', async () => {
    const calls: { method: string; url: string; body: unknown }[] = []
    setEmailFetch(async (url, init) => {
      calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : null })
      if (url.endsWith('/createReply')) return new Response(JSON.stringify({ id: 'draft-1' }), { status: 201 })
      if (init.method === 'PATCH') return new Response('{}', { status: 200 })
      return new Response(null, { status: 202 })
    })
    expect(await microsoftAdapter.send(account, 'tok', msg)).toMatchObject({ outcome: 'accepted', providerThreadId: 'conv-o1' })
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual(['POST https://graph.microsoft.com/v1.0/me/messages/AAMk-o1/reply'])
    expect(calls[0].body).toMatchObject({ message: { toRecipients: [{ emailAddress: { address: 'kim@client-co.example' } }], ccRecipients: [], body: { content: 'Thanks' } } })
    calls.length = 0
    expect(await microsoftAdapter.send({ ...account, scopes: ['Mail.Send', 'Mail.ReadWrite'] }, 'tok', msg)).toMatchObject({ outcome: 'accepted' })
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual(['POST https://graph.microsoft.com/v1.0/me/messages/AAMk-o1/createReply', 'PATCH https://graph.microsoft.com/v1.0/me/messages/draft-1', 'POST https://graph.microsoft.com/v1.0/me/messages/draft-1/send'])
    expect(microsoftAdapter.scopesFor({ read: false, inbox: true })).toContain('Mail.Read')
    expect(microsoftAdapter.scopesFor({ read: true })).not.toContain('Mail.Read')
    expect(microsoftAdapter.canReadInbox!(['Mail.ReadBasic'])).toBe(false)
    expect(gmailAdapter.scopesFor({ read: false, inbox: true })).toContain(GMAIL_READ)
  })
})
