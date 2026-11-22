/**
 * Outlook / Microsoft 365 inbox reader (Microsoft Graph v1.0; needs Mail.Read, with offline_access).
 *  - Delta query on /me/mailFolders/inbox/messages/delta: follow every @odata.nextLink until the
 *    @odata.deltaLink, which is stored and used next time. The first round is bounded to the last 7 days
 *    ($filter=receivedDateTime ge ..., the one filter delta supports on messages). A 410 Gone means the
 *    delta token expired: start a new bounded round.
 *  - Each new message: GET /me/messages/{id} with selected fields, the internetMessageHeaders (loop and
 *    authentication headers) and attachment metadata only ($expand=attachments($select=name,contentType,size));
 *    the body as text (Prefer: outlook.body-content-type="text").
 *  - Sent Items delta as well (conversationId and sentDateTime only), so a reply the owner sent from Outlook
 *    counts as an answer.
 *  - Optional push: a change-notification subscription on the inbox with a random clientState (only its
 *    hash is stored), validated on every notification; renewed before it expires.
 * Sources: learn.microsoft.com/graph/api/message-delta, /graph/delta-query-messages, /graph/api/message-get,
 * /graph/api/resources/internetmessageheader, /graph/api/subscription-post-subscriptions, /graph/change-notifications-delivery-webhooks.
 */
import { emailConfig } from '../config'
import { parseGraphMessage, type GraphMessage, type ProviderMessage } from './parse'
import { readJson, ReadError } from './http'
import type { ReadBatch } from './gmail'

export const GRAPH = 'https://graph.microsoft.com/v1.0'
const MAX_PAGES = 20
const SELECT = 'id,conversationId,internetMessageId,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,isDraft,body,hasAttachments,internetMessageHeaders'

const since = () => new Date(Date.now() - emailConfig.inboxLookbackDays * 864e5).toISOString().replace(/\.\d{3}Z$/, 'Z')
const firstRound = (folder: 'inbox' | 'sentitems', select: string) => `${GRAPH}/me/mailFolders/${folder}/messages/delta?${new URLSearchParams({ $select: select, $filter: `receivedDateTime ge ${since()}` })}`

/** Only Graph's own links are followed (a stored link can never point the token anywhere else). */
const graphLink = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' && x.host === 'graph.microsoft.com' } catch { return false } }

async function delta(token: string, start: string | null, folder: 'inbox' | 'sentitems', select: string): Promise<{ items: GraphMessage[]; deltaLink: string; full: boolean }> {
  let url = start && graphLink(start) ? start : firstRound(folder, select)
  let full = !start
  const items: GraphMessage[] = []
  for (let n = 0; ; n++) {
    let r: Record<string, unknown>
    try { r = await readJson(url, token, { headers: { prefer: 'odata.maxpagesize=50' }, goneOn: [410] }) } catch (e) {
      if (e instanceof ReadError && e.kind === 'gone' && !full) { url = firstRound(folder, select); full = true; items.length = 0; continue }
      throw e
    }
    for (const v of (Array.isArray(r.value) ? r.value : []) as GraphMessage[]) items.push(v)
    const nextLink = r['@odata.nextLink'], deltaLink = r['@odata.deltaLink']
    if (typeof deltaLink === 'string' && graphLink(deltaLink)) return { items, deltaLink, full }
    if (typeof nextLink !== 'string' || !graphLink(nextLink)) throw new ReadError('bad', 200, 'Graph returned neither a next link nor a delta link')
    if (n >= MAX_PAGES) return { items, deltaLink: nextLink, full } // continue from here on the next sync
    url = nextLink
  }
}

export async function graphRead(token: string, cursor: string | null, sentCursor: string | null, opts: { max?: number } = {}): Promise<ReadBatch> {
  const max = opts.max ?? emailConfig.inboxMaxPerSync
  const inbox = await delta(token, cursor, 'inbox', 'id,receivedDateTime,isDraft')
  const ids = [...new Set(inbox.items.filter(m => typeof m.id === 'string' && !m['@removed'] && !m.isDraft).map(m => m.id!))]
  const messages: ProviderMessage[] = []
  let skipped = Math.max(0, ids.length - max)
  for (const id of ids.slice(0, max)) {
    let m: GraphMessage
    try {
      m = await readJson(`${GRAPH}/me/messages/${encodeURIComponent(id)}?${new URLSearchParams({ $select: SELECT, $expand: 'attachments($select=name,contentType,size)' })}`, token,
        { headers: { prefer: 'outlook.body-content-type="text"' } }) as GraphMessage
    } catch (e) { if (e instanceof ReadError && e.status === 404) { skipped++; continue } throw e } // moved or deleted since the delta
    const p = parseGraphMessage(m)
    if (p && p.from) messages.push(p); else skipped++
  }
  const sentDelta = await delta(token, sentCursor, 'sentitems', 'conversationId,sentDateTime')
  const sent = sentDelta.items.filter(m => !m['@removed'] && typeof m.conversationId === 'string' && typeof (m as { sentDateTime?: string }).sentDateTime === 'string')
    .map(m => ({ threadId: m.conversationId!, at: new Date((m as { sentDateTime: string }).sentDateTime).toISOString() }))
  return { messages, sent, cursor: inbox.deltaLink, sentCursor: sentDelta.deltaLink, full: inbox.full, skipped }
}

/** Create (or renew) the inbox change-notification subscription. Deploi asks for 2 days and renews a day before (within Graph's maximum lifetime for mail subscriptions). */
export async function graphSubscribe(token: string, existing: { id: string | null }, clientState: string | null): Promise<{ id: string; expiresAt: string }> {
  const expirationDateTime = new Date(Date.now() + 2 * 864e5).toISOString()
  if (existing.id) {
    try {
      const r = await readJson(`${GRAPH}/subscriptions/${encodeURIComponent(existing.id)}`, token, { method: 'PATCH', body: { expirationDateTime } }) as { id?: string; expirationDateTime?: string }
      return { id: String(r.id ?? existing.id), expiresAt: String(r.expirationDateTime ?? expirationDateTime) }
    } catch (e) { if (!(e instanceof ReadError) || e.status !== 404 || !clientState) throw e }
  }
  if (!clientState) throw new ReadError('bad', 0, 'a new subscription needs a clientState')
  const r = await readJson(`${GRAPH}/subscriptions`, token, { method: 'POST', body: { changeType: 'created', notificationUrl: emailConfig.graphPushUrl, resource: "me/mailFolders('inbox')/messages", expirationDateTime, clientState } }) as { id?: string; expirationDateTime?: string }
  if (!r.id) throw new ReadError('bad', 201, 'Graph did not return a subscription id')
  return { id: String(r.id), expiresAt: String(r.expirationDateTime ?? expirationDateTime) }
}
