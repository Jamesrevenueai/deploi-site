/**
 * Outlook / Microsoft 365 calendar through Microsoft Graph v1.0 (Calendars.ReadWrite, on the Microsoft 365 account
 * connected with mail AND calendar). The token is the email account's (lib/email/accounts.ts): refreshed before it
 * expires, and once more when Graph answers 401.
 *  - list:   GET /me/calendarView?startDateTime&endDateTime (times in UTC: Prefer outlook.timezone="UTC")
 *  - create: POST /me/events with a transactionId, so a repeated create after a lost answer makes no second event
 *  - update: PATCH /me/events/{id}; cancel: POST /me/events/{id}/cancel (attendees are told)
 *  - delta:  GET /me/calendarView/delta over a window (default: 30 days back, 180 ahead): follow @odata.nextLink to the
 *            @odata.deltaLink, which is stored and used next time; 410 Gone restarts the window. Each changed or removed
 *            event becomes one 'calendar.changed' agent event (deduped on event id + changeKey).
 * Sources: learn.microsoft.com/graph/api/user-list-calendarview, /graph/api/user-post-events, /graph/api/event-update,
 * /graph/api/event-cancel, /graph/delta-query-events. Not live-verified: tested against a fake HTTP layer only.
 */
import { admin } from '../db'
import { OfficeHttpError, officeRequest } from '../office/http'
import { withOfficeToken, type TokenSource } from '../office/token'
import { accessToken, type EmailAccountRow } from '../email/accounts'
import { canUseCalendar } from '../email/adapters/microsoft'
import { countWorkflow } from '../ai/meter'
import { readCursor, saveCursor } from '../connections/cursors'
import { emitConnectionEvent } from '../connections/events'

export const GRAPH = 'https://graph.microsoft.com/v1.0'
const SELECT = 'id,subject,start,end,attendees,isCancelled,changeKey,webLink,showAs,organizer,lastModifiedDateTime,onlineMeeting'
const MAX_PAGES = 20
export const CALENDAR_STREAM = 'outlook.calendar'

export type OutlookEvent = { id: string; subject: string | null; start: string | null; end: string | null; attendees: string[]; cancelled: boolean; changeKey: string | null; webLink: string | null; joinUrl: string | null; updatedAt: string | null }
export type NewOutlookEvent = { subject: string; body?: string; start: string; end: string; timeZone?: string; attendees?: string[]; online?: boolean; location?: string | null; transactionId: string }

type GEvent = { id?: string; subject?: string; start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string; timeZone?: string }; attendees?: { emailAddress?: { address?: string } }[]
  isCancelled?: boolean; changeKey?: string; webLink?: string; onlineMeeting?: { joinUrl?: string } | null; lastModifiedDateTime?: string; '@removed'?: { reason?: string } }

const utc = (v?: { dateTime?: string; timeZone?: string }) => (v?.dateTime ? (v.timeZone && v.timeZone !== 'UTC' ? v.dateTime : `${v.dateTime.replace(/\.\d+$/, '').replace(/Z$/, '')}Z`) : null)
export const toOutlookEvent = (e: GEvent): OutlookEvent => ({
  id: String(e.id ?? ''), subject: e.subject?.slice(0, 255) ?? null, start: utc(e.start), end: utc(e.end),
  attendees: (e.attendees ?? []).map(a => a.emailAddress?.address?.toLowerCase() ?? '').filter(Boolean).slice(0, 100), cancelled: Boolean(e.isCancelled), changeKey: e.changeKey ?? null,
  webLink: e.webLink ?? null, joinUrl: e.onlineMeeting?.joinUrl ?? null, updatedAt: e.lastModifiedDateTime ?? null,
})
const eventId = (id: string) => { if (!/^[A-Za-z0-9_=+/-]{10,400}$/.test(id)) throw new OfficeHttpError(400, 'invalid', 'not an Outlook event id', 'outlook'); return encodeURIComponent(id) }
const graphLink = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' && x.host === 'graph.microsoft.com' } catch { return false } }
const isoNoMs = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

export interface OutlookCalendarApi {
  listEvents(o: { start: Date; end: Date; top?: number }): Promise<OutlookEvent[]>
  getEvent(id: string): Promise<OutlookEvent | null>
  createEvent(e: NewOutlookEvent): Promise<OutlookEvent>
  updateEvent(id: string, patch: { subject?: string; body?: string; start?: string; end?: string; timeZone?: string; attendees?: string[] }): Promise<OutlookEvent>
  cancelEvent(id: string, comment?: string): Promise<void>
  /** one delta round: changed and removed events, and the link to continue from next time */
  delta(link: string | null, window?: { start: Date; end: Date }): Promise<{ changed: OutlookEvent[]; removed: string[]; deltaLink: string; restarted: boolean }>
}

export function outlookCalendarClient(tokens: TokenSource): OutlookCalendarApi {
  const call = <T>(url: string, init: RequestInit & { json?: unknown; retryServer?: boolean } = {}) =>
    withOfficeToken(tokens, async t => (await officeRequest<T>('outlook', url, { ...init, headers: { authorization: `Bearer ${t}`, prefer: 'outlook.timezone="UTC"', ...(init.headers as Record<string, string> | undefined ?? {}) } })).body)
  const firstRound = (w: { start: Date; end: Date }) => `${GRAPH}/me/calendarView/delta?${new URLSearchParams({ startDateTime: isoNoMs(w.start), endDateTime: isoNoMs(w.end) })}`
  const body = (p: { subject?: string; body?: string; start?: string; end?: string; timeZone?: string; attendees?: string[] }) => ({
    ...(p.subject !== undefined ? { subject: p.subject.slice(0, 255) } : {}), ...(p.body !== undefined ? { body: { contentType: 'Text', content: p.body.slice(0, 20000) } } : {}),
    ...(p.start ? { start: { dateTime: p.start, timeZone: p.timeZone ?? 'UTC' } } : {}), ...(p.end ? { end: { dateTime: p.end, timeZone: p.timeZone ?? 'UTC' } } : {}),
    ...(p.attendees ? { attendees: p.attendees.slice(0, 50).map(a => ({ emailAddress: { address: a }, type: 'required' })) } : {}),
  })
  return {
    async listEvents({ start, end, top }) {
      const q = new URLSearchParams({ startDateTime: isoNoMs(start), endDateTime: isoNoMs(end), $select: SELECT, $orderby: 'start/dateTime', $top: String(Math.min(Math.max(top ?? 50, 1), 200)) })
      const r = await call<{ value?: GEvent[] }>(`${GRAPH}/me/calendarView?${q}`, { retryServer: true })
      return (r.value ?? []).map(toOutlookEvent)
    },
    async getEvent(id) {
      try { return toOutlookEvent(await call<GEvent>(`${GRAPH}/me/events/${eventId(id)}?$select=${SELECT}`, { retryServer: true })) } catch (e) { if (e instanceof OfficeHttpError && e.code === 'not_found') return null; throw e }
    },
    async createEvent(e) {
      if (!/^[\w-]{8,100}$/.test(e.transactionId)) throw new OfficeHttpError(400, 'invalid', 'a transactionId is needed so a repeated create makes no second event', 'outlook')
      const r = await call<GEvent>(`${GRAPH}/me/events`, { method: 'POST', json: { ...body(e), transactionId: e.transactionId, ...(e.location ? { location: { displayName: e.location.slice(0, 255) } } : {}),
        ...(e.online ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}) } })
      if (!r.id) throw new OfficeHttpError(201, 'server', 'Microsoft 365 did not return the new event', 'outlook')
      return toOutlookEvent(r)
    },
    async updateEvent(id, patch) { return toOutlookEvent(await call<GEvent>(`${GRAPH}/me/events/${eventId(id)}`, { method: 'PATCH', json: body(patch) })) },
    async cancelEvent(id, comment) { await call(`${GRAPH}/me/events/${eventId(id)}/cancel`, { method: 'POST', json: { comment: (comment ?? '').slice(0, 2000) } }) },
    async delta(link, window) {
      const w = window ?? { start: new Date(Date.now() - 30 * 864e5), end: new Date(Date.now() + 180 * 864e5) }
      let url = link && graphLink(link) ? link : firstRound(w)
      let restarted = !link
      const changed: OutlookEvent[] = [], removed: string[] = []
      for (let n = 0; ; n++) {
        let r: { value?: GEvent[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }
        try { r = await call(url, { retryServer: true, headers: { prefer: 'odata.maxpagesize=50' } }) } catch (e) {
          // the delta token expired: start the window again (every event in it is reported once more, and deduped)
          if (e instanceof OfficeHttpError && e.code === 'gone' && !restarted) { url = firstRound(w); restarted = true; changed.length = 0; removed.length = 0; continue }
          throw e
        }
        for (const v of r.value ?? []) { if (!v.id) continue; if (v['@removed']) removed.push(v.id); else changed.push(toOutlookEvent(v)) }
        const next = r['@odata.nextLink'], dl = r['@odata.deltaLink']
        if (typeof dl === 'string' && graphLink(dl)) return { changed, removed, deltaLink: dl, restarted }
        if (typeof next !== 'string' || !graphLink(next)) throw new OfficeHttpError(200, 'server', 'Microsoft 365 returned neither a next link nor a delta link', 'outlook')
        if (n >= MAX_PAGES) return { changed, removed, deltaLink: next, restarted }
        url = next
      }
    },
  }
}

/** The token of a connected Microsoft 365 account, as a TokenSource (refresh-once on 401). */
export function accountTokens(acc: Pick<EmailAccountRow, 'id' | 'org_id'>): TokenSource {
  return {
    get: () => { countWorkflow(acc.org_id, 'provider_call', 'microsoft_graph'); return accessToken(acc.id) },
    refresh: rejected => { countWorkflow(acc.org_id, 'provider_call', 'microsoft_graph'); return accessToken(acc.id, { force: true, rejected }) },
  }
}

export function outlookCalendarFor(acc: Pick<EmailAccountRow, 'id' | 'org_id' | 'provider' | 'granted_scopes' | 'status'>): OutlookCalendarApi {
  if (acc.provider !== 'microsoft') throw new Error('not a Microsoft 365 account')
  if (!canUseCalendar(acc.granted_scopes)) throw new OfficeHttpError(403, 'forbidden', 'this Microsoft 365 account was connected without calendar access; reconnect it with mail and calendar', 'outlook')
  return outlookCalendarClient(accountTokens(acc))
}

/** Read what changed in the calendar since the last sync and hand each change to the agents once. */
export async function syncOutlookCalendar(accountId: string, opts: { client?: OutlookCalendarApi } = {}): Promise<{ status: 'synced'; changed: number; removed: number; emitted: number } | { status: 'not_readable'; reason: string }> {
  const acc = await admin(db => db.one<EmailAccountRow>('select * from email_accounts where id = $1', [accountId]))
  if (!acc || acc.status !== 'active' || acc.provider !== 'microsoft' || !canUseCalendar(acc.granted_scopes)) return { status: 'not_readable', reason: 'no active Microsoft 365 account with calendar access' }
  const cur = await admin(db => readCursor(db, acc.id, CALENDAR_STREAM))
  const client = opts.client ?? outlookCalendarFor(acc)
  let r: Awaited<ReturnType<OutlookCalendarApi['delta']>>
  try { r = await client.delta(cur?.sync_position ?? null) } catch (e) {
    const code = e instanceof OfficeHttpError ? e.code : 'error'
    await admin(db => saveCursor(db, { orgId: acc.org_id, connectionId: acc.id, stream: CALENDAR_STREAM, position: null, changes: 0, errorCode: code }))
    throw e
  }
  const now = new Date().toISOString()
  let emitted = 0
  await admin(async db => {
    for (const ev of r.changed) {
      if ((await emitConnectionEvent(db, { source: 'calendar', type: 'calendar.changed', orgId: acc.org_id, connectionId: acc.id, externalId: `outlook:${ev.id}:${ev.changeKey ?? ev.updatedAt ?? 'v'}`, occurredAt: ev.updatedAt ?? now,
        payload: { provider: 'outlook', accountId: acc.id, change: ev.cancelled ? 'cancelled' : 'updated', event: ev } })) === 'emitted') emitted++
    }
    for (const id of r.removed) {
      if ((await emitConnectionEvent(db, { source: 'calendar', type: 'calendar.changed', orgId: acc.org_id, connectionId: acc.id, externalId: `outlook:${id}:removed`, occurredAt: now,
        payload: { provider: 'outlook', accountId: acc.id, change: 'removed', eventId: id } })) === 'emitted') emitted++
    }
    // the position moves only after every change was recorded
    await saveCursor(db, { orgId: acc.org_id, connectionId: acc.id, stream: CALENDAR_STREAM, position: r.deltaLink, changes: r.changed.length + r.removed.length })
  })
  return { status: 'synced', changed: r.changed.length, removed: r.removed.length, emitted }
}
