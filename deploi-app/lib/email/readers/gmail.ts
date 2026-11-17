/**
 * Gmail inbox reader (Gmail API v1, official endpoints only; needs gmail.readonly).
 *  - Incremental: users.history.list from the stored historyId (historyTypes=messageAdded), every page.
 *    A 404 means the historyId is too old: fall back to a bounded full resync.
 *  - Full resync: users.getProfile for the current historyId first (so nothing between the list and the
 *    cursor is lost), then messages.list q="newer_than:7d in:inbox -category:promotions" (bounded), plus
 *    "in:sent newer_than:7d" to notice replies the owner sent from Gmail itself.
 *  - Each new message: messages.get format=metadata (labels, headers, size), then format=full only when it
 *    is in the inbox, not spam / trash / draft / promotions, and small enough. Attachments: metadata only.
 *  - Optional push: users.watch on INBOX to a Pub/Sub topic (renewed before it expires; Google asks for a
 *    renewal at least every 7 days).
 * Sources: developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list,
 * users.messages/list, users.messages/get, users/getProfile, users/watch; guides/sync, guides/push.
 */
import { emailConfig } from '../config'
import { parseGmailMessage, type GmailMessage, type ProviderMessage } from './parse'
import { readJson, ReadError } from './http'

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const MAX_PAGES = 20
const SKIP_LABELS = ['SPAM', 'TRASH', 'DRAFT', 'CATEGORY_PROMOTIONS']

export type ReadBatch = {
  messages: ProviderMessage[]
  /** replies the account itself sent: (thread, time) so earlier inbound mail in that thread counts as answered */
  sent: { threadId: string; at: string }[]
  cursor: string
  sentCursor?: string | null
  full: boolean
  /** messages seen but not stored (spam, promotions, not in the inbox, too many for one sync) */
  skipped: number
}

async function getMessage(token: string, id: string): Promise<{ meta: GmailMessage; full: GmailMessage | null }> {
  const meta = (await readJson(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=metadata`, token)) as GmailMessage
  const labels = Array.isArray(meta.labelIds) ? meta.labelIds : []
  const wanted = labels.includes('INBOX') && !labels.some(l => SKIP_LABELS.includes(l))
  if (!wanted || Number(meta.sizeEstimate ?? 0) > emailConfig.inboxMaxMessageBytes) return { meta, full: null }
  return { meta, full: (await readJson(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`, token)) as GmailMessage }
}

export async function gmailRead(token: string, cursor: string | null, opts: { max?: number } = {}): Promise<ReadBatch> {
  const max = opts.max ?? emailConfig.inboxMaxPerSync
  let ids: string[] = [], next = cursor, full = false, sentIds: string[] = []
  if (cursor) {
    try {
      let page: string | null = null, n = 0
      do {
        const q = new URLSearchParams({ startHistoryId: cursor, historyTypes: 'messageAdded', maxResults: '500' })
        if (page) q.set('pageToken', page)
        const r = await readJson(`${GMAIL_API}/history?${q}`, token, { goneOn: [404] }) as { history?: { messagesAdded?: { message?: { id?: string; labelIds?: string[] } }[] }[]; nextPageToken?: string; historyId?: string }
        for (const h of r.history ?? []) for (const a of h.messagesAdded ?? []) {
          const id = a.message?.id
          if (typeof id !== 'string') continue
          if ((a.message?.labelIds ?? []).includes('SENT')) sentIds.push(id); else ids.push(id)
        }
        if (r.historyId) next = String(r.historyId)
        page = r.nextPageToken ?? null
      } while (page && ++n < MAX_PAGES)
    } catch (e) {
      if (!(e instanceof ReadError) || e.kind !== 'gone') throw e
      full = true
    }
  } else full = true
  if (full) {
    ids = []; sentIds = []
    const profile = await readJson(`${GMAIL_API}/profile`, token) as { historyId?: string }
    if (!profile.historyId) throw new ReadError('bad', 200, 'Gmail did not return a history id')
    next = String(profile.historyId)
    const list = async (q: string, limit: number) => {
      const out: string[] = []
      let page: string | null = null, n = 0
      do {
        const p = new URLSearchParams({ q, maxResults: '100', includeSpamTrash: 'false' })
        if (page) p.set('pageToken', page)
        const r = await readJson(`${GMAIL_API}/messages?${p}`, token) as { messages?: { id?: string }[]; nextPageToken?: string }
        for (const m of r.messages ?? []) if (typeof m.id === 'string') out.push(m.id)
        page = r.nextPageToken ?? null
      } while (page && out.length < limit && ++n < 5)
      return out.slice(0, limit)
    }
    ids = await list(`newer_than:${emailConfig.inboxLookbackDays}d in:inbox -category:promotions`, max)
    sentIds = await list(`newer_than:${emailConfig.inboxLookbackDays}d in:sent`, 100)
  }
  const uniq = [...new Set(ids)]
  const messages: ProviderMessage[] = []
  let skipped = Math.max(0, uniq.length - max)
  for (const id of uniq.slice(0, max)) {
    const { meta, full: body } = await getMessage(token, id)
    const labels = Array.isArray(meta.labelIds) ? meta.labelIds : []
    if (labels.includes('SENT')) { sentIds.push(id); continue }
    if (!labels.includes('INBOX') || labels.some(l => SKIP_LABELS.includes(l))) { skipped++; continue }
    const p = parseGmailMessage(body ?? meta, { bodyFetched: Boolean(body) })
    if (p && p.from) messages.push(p); else skipped++
  }
  const sent: ReadBatch['sent'] = []
  for (const id of [...new Set(sentIds)].slice(0, 100)) {
    const m = await readJson(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=minimal`, token) as GmailMessage
    const t = Number(m.internalDate)
    if (typeof m.threadId === 'string' && Number.isFinite(t)) sent.push({ threadId: m.threadId, at: new Date(t).toISOString() })
  }
  return { messages, sent, cursor: next!, full, skipped }
}

/** users.watch on the inbox (optional push). Returns the expiry Google set. */
export async function gmailWatch(token: string, topicName: string): Promise<{ historyId: string | null; expiresAt: string | null }> {
  const r = await readJson(`${GMAIL_API}/watch`, token, { method: 'POST', body: { topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' } }) as { historyId?: string; expiration?: string }
  const exp = Number(r.expiration)
  return { historyId: r.historyId ? String(r.historyId) : null, expiresAt: Number.isFinite(exp) && exp > 0 ? new Date(exp).toISOString() : null }
}
