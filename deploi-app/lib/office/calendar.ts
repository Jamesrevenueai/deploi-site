/**
 * Google Calendar (OAuth 2.0 with PKCE + Calendar API v3). Scopes, the narrowest that cover the work:
 *  - calendar.events.owned      create, change and delete events on calendars the user owns (no access to other calendars' settings)
 *  - calendar.freebusy          see availability only (busy times, never event titles or attendees)
 *  - openid email               the account's address, to show which calendar is connected
 * Events are created with a deterministic id derived from the action's idempotency key, so a repeated or
 * uncertain insert can never create a second event: it answers 409 and the existing event is read back.
 * Not live-verified: see docs/OFFICE-SETUP.md.
 */
import { createHash } from 'node:crypto'
import { officeConfig } from './config'
import { OfficeHttpError, officeRequest, tokenPost } from './http'
import type { OAuthTokens } from './hubspot'
import type { BusyInterval, CalendarApi, CalendarEvent, NewEvent } from './types'

export const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo'
const API = 'https://www.googleapis.com/calendar/v3'
export const CAL_EVENTS = 'https://www.googleapis.com/auth/calendar.events.owned'
export const CAL_FREEBUSY = 'https://www.googleapis.com/auth/calendar.freebusy'
export const GOOGLE_CALENDAR_SCOPES = ['openid', 'email', CAL_EVENTS, CAL_FREEBUSY] as const
/** a broader grant also covers the work (a user may already have granted it to the same client) */
const EVENTS_OK = [CAL_EVENTS, 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar']
const FREEBUSY_OK = [CAL_FREEBUSY, 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events.freebusy', 'https://www.googleapis.com/auth/calendar']
export const calendarScopesOk = (s: string[]) => EVENTS_OK.some(x => s.includes(x)) && FREEBUSY_OK.some(x => s.includes(x))

export function googleAuthorizeUrl(state: string, codeChallenge: string, loginHint?: string | null): string {
  const q = new URLSearchParams({ client_id: officeConfig.googleClientId, redirect_uri: officeConfig.googleRedirectUrl, response_type: 'code', scope: GOOGLE_CALENDAR_SCOPES.join(' '),
    state, code_challenge: codeChallenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' })
  if (loginHint) q.set('login_hint', loginHint)
  return `${GOOGLE_AUTHORIZE}?${q}`
}

function tokenSet(j: Record<string, unknown>, fallback: string[]): OAuthTokens {
  return { accessToken: String(j.access_token ?? ''), refreshToken: j.refresh_token ? String(j.refresh_token) : null, expiresIn: typeof j.expires_in === 'number' ? j.expires_in : null,
    scopes: typeof j.scope === 'string' ? j.scope.split(' ').filter(Boolean) : fallback }
}

export async function googleExchange(code: string, verifier: string): Promise<OAuthTokens> {
  const r = await tokenPost('google_calendar', GOOGLE_TOKEN, { code, client_id: officeConfig.googleClientId, client_secret: officeConfig.googleClientSecret, redirect_uri: officeConfig.googleRedirectUrl, grant_type: 'authorization_code', code_verifier: verifier })
  if (r.status !== 200 || !r.json.access_token) throw new Error(`Google token exchange failed (${String(r.json.error ?? r.status).slice(0, 40)})`)
  return tokenSet(r.json, [...GOOGLE_CALENDAR_SCOPES])
}

export async function googleRefresh(refreshToken: string, scopes: string[]): Promise<OAuthTokens> {
  const r = await tokenPost('google_calendar', GOOGLE_TOKEN, { refresh_token: refreshToken, client_id: officeConfig.googleClientId, client_secret: officeConfig.googleClientSecret, grant_type: 'refresh_token' })
  if (r.status !== 200 || !r.json.access_token) throw Object.assign(new Error(`Google token refresh failed (${String(r.json.error ?? r.status).slice(0, 40)})`), { auth: r.json.error === 'invalid_grant' })
  const t = tokenSet(r.json, scopes)
  return { ...t, refreshToken: t.refreshToken ?? refreshToken }
}

export async function googleIdentity(accessToken: string): Promise<{ email: string }> {
  const r = await officeRequest<{ email?: string }>('google_calendar', USERINFO, { headers: { authorization: `Bearer ${accessToken}` } })
  if (!r.body.email) throw new Error('the Google account has no email address')
  return { email: r.body.email.toLowerCase() }
}

/** Google event ids: 5 to 1024 characters from base32hex (a-v, 0-9). Hex output fits. */
export function eventIdFor(idempotencyKey: string): string {
  return 'dpl' + createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 40)
}

type GEvent = { id: string; status?: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; attendees?: { email: string }[]; hangoutLink?: string; htmlLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] } }

export function toEvent(g: GEvent): CalendarEvent {
  const meet = g.hangoutLink ?? g.conferenceData?.entryPoints?.find(p => p.entryPointType === 'video')?.uri ?? null
  return { id: g.id, status: (g.status as CalendarEvent['status']) ?? 'confirmed', summary: g.summary ?? '', start: new Date(g.start?.dateTime ?? g.start?.date ?? 0).toISOString(), end: new Date(g.end?.dateTime ?? g.end?.date ?? 0).toISOString(),
    attendees: (g.attendees ?? []).map(a => a.email.toLowerCase()), meetLink: meet, htmlLink: g.htmlLink ?? null }
}

export function calendarClient(token: () => Promise<string>, calendarId = 'primary'): CalendarApi {
  const cal = encodeURIComponent(calendarId)
  const call = async <T>(url: string, init: RequestInit & { json?: unknown } = {}) => (await officeRequest<T>('google_calendar', url, { ...init, headers: { authorization: `Bearer ${await token()}` } })).body
  const evId = (id: string) => { if (!/^[a-v0-9]{5,1024}$/.test(id)) throw new OfficeHttpError(400, 'invalid', 'not a calendar event id', 'google_calendar'); return encodeURIComponent(id) }
  const api: CalendarApi = {
    async freeBusy({ timeMin, timeMax, timeZone }) {
      const r = await call<{ calendars?: Record<string, { busy?: BusyInterval[]; errors?: { reason: string }[] }> }>(`${API}/freeBusy`, { method: 'POST', json: { timeMin, timeMax, timeZone, items: [{ id: calendarId }] } })
      const c = r.calendars?.[calendarId] ?? Object.values(r.calendars ?? {})[0]
      if (!c) throw new OfficeHttpError(502, 'server', 'Google Calendar returned no availability for the calendar', 'google_calendar')
      if (c.errors?.length) throw new OfficeHttpError(403, 'forbidden', `Google Calendar could not read availability (${c.errors[0].reason})`, 'google_calendar')
      return (c.busy ?? []).map(b => ({ start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() }))
    },
    async insertEvent(e: NewEvent) {
      const q = new URLSearchParams({ sendUpdates: 'all', ...(e.meet ? { conferenceDataVersion: '1' } : {}) })
      const body = {
        id: e.id, summary: e.summary, description: e.description,
        start: { dateTime: e.start, timeZone: e.timeZone }, end: { dateTime: e.end, timeZone: e.timeZone },
        attendees: e.attendees.map(email => ({ email })),
        ...(e.meet ? { conferenceData: { createRequest: { requestId: e.requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
        reminders: { useDefault: true },
      }
      try { return toEvent(await call<GEvent>(`${API}/calendars/${cal}/events?${q}`, { method: 'POST', json: body })) } catch (err) {
        // the id is already taken: this exact event was created before (a retry); read it back instead of creating another
        if (err instanceof OfficeHttpError && err.code === 'conflict') { const found = await api.getEvent(e.id); if (found) return found }
        throw err
      }
    },
    async getEvent(id) {
      try { return toEvent(await call<GEvent>(`${API}/calendars/${cal}/events/${evId(id)}`)) } catch (e) {
        if (e instanceof OfficeHttpError && (e.code === 'not_found' || e.code === 'gone')) return null
        throw e
      }
    },
    async patchEvent(id, p) {
      return toEvent(await call<GEvent>(`${API}/calendars/${cal}/events/${evId(id)}?sendUpdates=all`, { method: 'PATCH', json: { start: { dateTime: p.start, timeZone: p.timeZone }, end: { dateTime: p.end, timeZone: p.timeZone } } }))
    },
    async deleteEvent(id) {
      try { await call(`${API}/calendars/${cal}/events/${evId(id)}?sendUpdates=all`, { method: 'DELETE' }); return 'deleted' } catch (e) {
        if (e instanceof OfficeHttpError && (e.code === 'gone' || e.code === 'not_found')) return 'already_gone'
        throw e
      }
    },
  }
  return api
}
