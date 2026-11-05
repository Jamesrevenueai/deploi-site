/** The HubSpot or Calendar client for a connection: synthetic connections get the synthetic provider, real ones the real client. */
import type { OfficeConnectionRow } from './connections'
import { officeAccessToken } from './credentials'
import { hubspotClient } from './hubspot'
import { calendarClient } from './calendar'
import { syntheticCalendar, syntheticHubSpot } from './synthetic'
import type { CalendarApi, HubSpotApi } from './types'
import { quickbooksClient, type QuickBooksApi } from './quickbooks'
import { syntheticQuickBooks } from './quickbooks-synthetic'

export function hubspotFor(c: Pick<OfficeConnectionRow, 'id' | 'provider' | 'is_synthetic'>): HubSpotApi {
  if (c.provider !== 'hubspot') throw new Error('not a HubSpot connection')
  return c.is_synthetic ? syntheticHubSpot(c.id) : hubspotClient(() => officeAccessToken(c.id))
}

export function calendarFor(c: Pick<OfficeConnectionRow, 'id' | 'provider' | 'is_synthetic' | 'calendar_id'>): CalendarApi {
  if (c.provider !== 'google_calendar') throw new Error('not a Google Calendar connection')
  return c.is_synthetic ? syntheticCalendar(c.id) : calendarClient(() => officeAccessToken(c.id), c.calendar_id ?? 'primary')
}

/** QuickBooks for a connection, always bound to the company (realmId) the connection was made with. */
export function quickbooksFor(c: Pick<OfficeConnectionRow, 'id' | 'provider' | 'is_synthetic' | 'external_account_id'>): QuickBooksApi {
  if (c.provider !== 'quickbooks') throw new Error('not a QuickBooks connection')
  return c.is_synthetic ? syntheticQuickBooks(c.id) : quickbooksClient(() => officeAccessToken(c.id), c.external_account_id)
}
