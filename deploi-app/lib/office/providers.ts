/** The HubSpot or Calendar client for a connection: synthetic connections get the synthetic provider, real ones the real client. */
import type { OfficeConnectionRow } from './connections'
import { officeAccessToken } from './credentials'
import { hubspotClient } from './hubspot'
import { calendarClient } from './calendar'
import { syntheticCalendar, syntheticHubSpot } from './synthetic'
import type { CalendarApi, HubSpotApi } from './types'

export function hubspotFor(c: Pick<OfficeConnectionRow, 'id' | 'provider' | 'is_synthetic'>): HubSpotApi {
  if (c.provider !== 'hubspot') throw new Error('not a HubSpot connection')
  return c.is_synthetic ? syntheticHubSpot(c.id) : hubspotClient(() => officeAccessToken(c.id))
}

export function calendarFor(c: Pick<OfficeConnectionRow, 'id' | 'provider' | 'is_synthetic' | 'calendar_id'>): CalendarApi {
  if (c.provider !== 'google_calendar') throw new Error('not a Google Calendar connection')
  return c.is_synthetic ? syntheticCalendar(c.id) : calendarClient(() => officeAccessToken(c.id), c.calendar_id ?? 'primary')
}
