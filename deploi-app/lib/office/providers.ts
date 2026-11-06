/** The HubSpot or Calendar client for a connection: synthetic connections get the synthetic provider, real ones the real client. */
import type { OfficeConnectionRow } from './connections'
import { officeAccessToken } from './credentials'
import { hubspotClient } from './hubspot'
import { calendarClient } from './calendar'
import { syntheticCalendar, syntheticHubSpot } from './synthetic'
import type { CalendarApi, HubSpotApi } from './types'
import { quickbooksClient, type QuickBooksApi } from './quickbooks'
import { syntheticQuickBooks } from './quickbooks-synthetic'
import { countWorkflow } from '../ai/meter'

/**
 * Workflow cost (lib/ai/meter.ts): each client asks for the access token once per API request, so counting
 * there counts every real HubSpot, Calendar and QuickBooks call per organization (synthetic ones are free).
 */
type Metered = { org_id?: string }
const meteredToken = (c: { id: string } & Metered, connector: 'hubspot' | 'google_calendar' | 'quickbooks') => () => {
  countWorkflow(c.org_id, 'provider_call', connector)
  return officeAccessToken(c.id)
}

export function hubspotFor(c: Pick<OfficeConnectionRow, 'id' | 'provider' | 'is_synthetic'> & Metered): HubSpotApi {
  if (c.provider !== 'hubspot') throw new Error('not a HubSpot connection')
  return c.is_synthetic ? syntheticHubSpot(c.id) : hubspotClient(meteredToken(c, 'hubspot'))
}

export function calendarFor(c: Pick<OfficeConnectionRow, 'id' | 'provider' | 'is_synthetic' | 'calendar_id'> & Metered): CalendarApi {
  if (c.provider !== 'google_calendar') throw new Error('not a Google Calendar connection')
  return c.is_synthetic ? syntheticCalendar(c.id) : calendarClient(meteredToken(c, 'google_calendar'), c.calendar_id ?? 'primary')
}

/** QuickBooks for a connection, always bound to the company (realmId) the connection was made with. */
export function quickbooksFor(c: Pick<OfficeConnectionRow, 'id' | 'provider' | 'is_synthetic' | 'external_account_id'> & Metered): QuickBooksApi {
  if (c.provider !== 'quickbooks') throw new Error('not a QuickBooks connection')
  return c.is_synthetic ? syntheticQuickBooks(c.id) : quickbooksClient(meteredToken(c, 'quickbooks'), c.external_account_id)
}
