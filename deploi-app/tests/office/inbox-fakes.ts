/**
 * Fake Gmail API and Microsoft Graph for inbox-reading tests (no network). Request and response shapes
 * follow the providers' reference pages: users.history.list, users.messages.list/get/send, users.getProfile,
 * users.watch (Gmail v1); message delta with @odata.nextLink / @odata.deltaLink, 410 Gone for an expired
 * delta token, message get with internetMessageHeaders, message reply (Graph v1.0).
 */
import { randomBytes } from 'node:crypto'

export type Call = { method: string; url: string; body: unknown; headers: Record<string, string> }
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } })
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url')

export type GmailFakeMessage = {
  id: string; threadId: string; labelIds: string[]; internalDate: number
  headers: Record<string, string | string[]>
  /** text/plain body; a payload overrides the whole MIME tree (malformed input tests) */
  text?: string; html?: string; payload?: unknown; sizeEstimate?: number
  attachments?: { filename: string; mimeType: string; size: number }[]
}

export function gmailFake() {
  const s = {
    address: 'owner@northwind-mail.example',
    messages: new Map<string, GmailFakeMessage>(),
    /** history entries: each adds one message */
    history: [] as { id: number; messageId: string }[],
    historyId: 1000,
    /** history ids at or below this are expired (404) */
    expiredBelow: 0,
    /** force a status on every API call (401, 429, 503) */
    fail: null as null | { status: number; headers?: Record<string, string>; body?: unknown },
    sent: [] as { raw: string; threadId?: string }[],
    calls: [] as Call[],
    refresh: 'ok' as 'ok' | 'invalid_grant',
  }
  const headerList = (h: GmailFakeMessage['headers']) => Object.entries(h).flatMap(([name, v]) => (Array.isArray(v) ? v : [v]).map(value => ({ name, value })))
  const payloadOf = (m: GmailFakeMessage, full: boolean) => {
    if (m.payload !== undefined) return full ? m.payload : { headers: headerList(m.headers) }
    const parts: unknown[] = []
    if (m.text !== undefined) parts.push({ partId: '0', mimeType: 'text/plain', filename: '', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { size: m.text.length, ...(full ? { data: b64url(m.text) } : {}) } })
    if (m.html !== undefined) parts.push({ partId: '1', mimeType: 'text/html', filename: '', headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }], body: { size: m.html.length, ...(full ? { data: b64url(m.html) } : {}) } })
    for (const [i, a] of (m.attachments ?? []).entries()) parts.push({ partId: `a${i}`, mimeType: a.mimeType, filename: a.filename, headers: [{ name: 'Content-Disposition', value: `attachment; filename="${a.filename}"` }], body: { attachmentId: `att-${i}`, size: a.size } })
    return { partId: '', mimeType: 'multipart/mixed', filename: '', headers: headerList(m.headers), body: { size: 0 }, parts }
  }
  const resource = (m: GmailFakeMessage, format: string) => ({
    id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: String(m.internalDate), historyId: String(s.historyId),
    sizeEstimate: m.sizeEstimate ?? 2000, snippet: (m.text ?? '').slice(0, 100), ...(format === 'minimal' ? {} : { payload: payloadOf(m, format === 'full') }),
  })
  /** add a message to the mailbox (and to history) */
  const add = (m: Omit<GmailFakeMessage, 'id' | 'threadId'> & { id?: string; threadId?: string }) => {
    const id = m.id ?? `g${randomBytes(5).toString('hex')}`
    const msg: GmailFakeMessage = { ...m, id, threadId: m.threadId ?? `th-${id}` }
    s.messages.set(id, msg)
    s.historyId += 1
    s.history.push({ id: s.historyId, messageId: id })
    return msg
  }
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET'
    const body = init.body ? (() => { try { return JSON.parse(String(init.body)) } catch { return String(init.body) } })() : undefined
    s.calls.push({ method, url, body, headers: Object.fromEntries(new Headers(init.headers).entries()) })
    if (url === 'https://oauth2.googleapis.com/token') return s.refresh === 'ok' ? json({ access_token: 'fresh-token', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly' }) : json({ error: 'invalid_grant' }, 400)
    const u = new URL(url)
    if (u.host !== 'gmail.googleapis.com') throw new Error(`unexpected host in test: ${url}`)
    if (s.fail) return json(s.fail.body ?? { error: { code: s.fail.status, message: 'fake failure' } }, s.fail.status, s.fail.headers)
    const path = u.pathname.replace('/gmail/v1/users/me', '')
    if (path === '/profile') return json({ emailAddress: s.address, messagesTotal: s.messages.size, threadsTotal: s.messages.size, historyId: String(s.historyId) })
    if (path === '/history') {
      const start = Number(u.searchParams.get('startHistoryId'))
      if (start < s.expiredBelow) return json({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }, 404)
      const after = s.history.filter(h => h.id > start)
      const page = Number(u.searchParams.get('pageToken') ?? 0)
      const slice = after.slice(page, page + 1) // one entry per page: exercises nextPageToken
      return json({
        history: slice.map(h => { const m = s.messages.get(h.messageId)!; return { id: String(h.id), messages: [{ id: m.id, threadId: m.threadId }], messagesAdded: [{ message: { id: m.id, threadId: m.threadId, labelIds: m.labelIds } }] } }),
        ...(page + 1 < after.length ? { nextPageToken: String(page + 1) } : {}),
        historyId: String(s.historyId),
      })
    }
    if (path === '/messages' && method === 'GET') {
      const q = u.searchParams.get('q') ?? ''
      const list = [...s.messages.values()].filter(m => q.includes('in:sent') ? m.labelIds.includes('SENT') : (m.labelIds.includes('INBOX') && !(q.includes('-category:promotions') && m.labelIds.includes('CATEGORY_PROMOTIONS'))))
      return json({ messages: list.map(m => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: list.length })
    }
    if (path === '/messages/send' && method === 'POST') {
      const b = body as { raw: string; threadId?: string }
      s.sent.push(b)
      const id = `sent-${s.sent.length}`
      return json({ id, threadId: b.threadId ?? `th-${id}`, labelIds: ['SENT'] })
    }
    if (path === '/watch' && method === 'POST') return json({ historyId: String(s.historyId), expiration: String(Date.now() + 7 * 864e5) })
    const mm = /^\/messages\/([^/]+)$/.exec(path)
    if (mm && method === 'GET') {
      const m = s.messages.get(decodeURIComponent(mm[1]))
      if (!m) return json({ error: { code: 404, message: 'Not Found' } }, 404)
      return json(resource(m, u.searchParams.get('format') ?? 'full'))
    }
    throw new Error(`unexpected Gmail call in test: ${method} ${url}`)
  }
  return { s, add, fetch }
}

/** The raw MIME Gmail was asked to send, decoded. */
export const decodeRaw = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8')

export type GraphFakeMessage = {
  id: string; conversationId: string; internetMessageId: string; subject: string; from: string; to: string[]; receivedDateTime: string
  body: string; contentType?: 'text' | 'html'; headers: { name: string; value: string }[]; attachments?: { name: string; contentType: string; size: number }[]; isDraft?: boolean
}

export function graphFake() {
  const s = {
    address: 'owner@harbor-mail.example',
    inbox: [] as GraphFakeMessage[],
    sentItems: [] as { id: string; conversationId: string; sentDateTime: string }[],
    removed: [] as string[],
    /** delta tokens that have expired (410) */
    expired: new Set<string>(),
    /** which inbox items each delta token has already seen */
    seen: new Map<string, number>(),
    sentSeen: new Map<string, number>(),
    tokens: 0,
    fail: null as null | { status: number; headers?: Record<string, string> },
    replies: [] as { messageId: string; body: unknown }[],
    subscriptions: [] as { id: string; body: unknown }[],
    calls: [] as Call[],
  }
  const G = 'https://graph.microsoft.com/v1.0'
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET'
    const body = init.body ? (() => { try { return JSON.parse(String(init.body)) } catch { return String(init.body) } })() : undefined
    s.calls.push({ method, url, body, headers: Object.fromEntries(new Headers(init.headers).entries()) })
    const u = new URL(url)
    if (u.host !== 'graph.microsoft.com') throw new Error(`unexpected host in test: ${url}`)
    if (s.fail) return json({ error: { code: 'fake', message: 'fake failure' } }, s.fail.status, s.fail.headers)
    const path = u.pathname.replace('/v1.0', '')
    const folder = /^\/me\/mailFolders\/(inbox|sentitems)\/messages\/delta$/.exec(path)?.[1]
    if (folder && method === 'GET') {
      const token = u.searchParams.get('$deltatoken'), skip = u.searchParams.get('$skiptoken')
      if (token && s.expired.has(token)) return json({ error: { code: 'SyncStateNotFound', message: 'The sync state generation is not found.' } }, 410)
      const all = folder === 'inbox' ? s.inbox : s.sentItems
      const seenMap = folder === 'inbox' ? s.seen : s.sentSeen
      const from = token ? seenMap.get(token) ?? 0 : 0
      const fresh = all.slice(from)
      // first page holds one item; the rest come after @odata.nextLink
      if (!skip && fresh.length > 1) return json({ value: fresh.slice(0, 1).map(m => deltaItem(m, folder)), '@odata.nextLink': `${G}/me/mailFolders/${folder}/messages/delta?$skiptoken=${from + 1}` })
      const startAt = skip ? Number(skip) : from
      const next = `d${++s.tokens}`
      seenMap.set(next, all.length)
      const removed = folder === 'inbox' && !skip ? s.removed.map(id => ({ id, '@removed': { reason: 'deleted' } })) : []
      return json({ value: [...all.slice(startAt).map(m => deltaItem(m, folder)), ...removed], '@odata.deltaLink': `${G}/me/mailFolders/${folder}/messages/delta?$deltatoken=${next}` })
    }
    const mm = /^\/me\/messages\/([^/]+)$/.exec(path)
    if (mm && method === 'GET') {
      const m = s.inbox.find(x => x.id === decodeURIComponent(mm[1]))
      if (!m) return json({ error: { code: 'ErrorItemNotFound', message: 'not found' } }, 404)
      return json({
        id: m.id, conversationId: m.conversationId, internetMessageId: m.internetMessageId, subject: m.subject, isDraft: Boolean(m.isDraft),
        from: { emailAddress: { address: m.from, name: 'Sender' } }, sender: { emailAddress: { address: m.from } }, toRecipients: m.to.map(a => ({ emailAddress: { address: a } })), ccRecipients: [],
        receivedDateTime: m.receivedDateTime, body: { contentType: m.contentType ?? 'text', content: m.body }, hasAttachments: Boolean(m.attachments?.length),
        internetMessageHeaders: m.headers, attachments: (m.attachments ?? []).map(a => ({ '@odata.type': '#microsoft.graph.fileAttachment', ...a })),
      })
    }
    const rm = /^\/me\/messages\/([^/]+)\/reply$/.exec(path)
    if (rm && method === 'POST') { s.replies.push({ messageId: decodeURIComponent(rm[1]), body }); return new Response(null, { status: 202 }) }
    if (path === '/subscriptions' && method === 'POST') { const id = `sub-${s.subscriptions.length + 1}`; s.subscriptions.push({ id, body }); return json({ id, expirationDateTime: new Date(Date.now() + 2 * 864e5).toISOString(), ...(body as object) }, 201) }
    throw new Error(`unexpected Graph call in test: ${method} ${url}`)
  }
  const deltaItem = (m: GraphFakeMessage | { id: string; conversationId: string; sentDateTime: string }, folder: string) =>
    folder === 'inbox' ? { id: m.id, receivedDateTime: (m as GraphFakeMessage).receivedDateTime, isDraft: Boolean((m as GraphFakeMessage).isDraft) } : m
  return { s, fetch }
}

/** Authentication-Results values as the receiving servers write them. */
export const GOOGLE_AUTH_PASS = 'mx.google.com; dkim=pass header.i=@client-co.example; spf=pass (google.com: domain of kim@client-co.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=kim@client-co.example; dmarc=pass (p=REJECT) header.from=client-co.example'
export const MS_AUTH_PASS = 'spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=client-co.example; dkim=pass (signature was verified) header.d=client-co.example;dmarc=pass action=none header.from=client-co.example;compauth=pass reason=100'
