/** The HubSpot or Calendar client for a connection: synthetic connections get the synthetic provider, real ones the real client. */
import type { OfficeConnectionRow } from './connections'
import { officeAccessToken, officeTokenSource } from './credentials'
import { hubspotClient } from './hubspot'
import { calendarClient } from './calendar'
import { syntheticCalendar, syntheticHubSpot } from './synthetic'
import type { CalendarApi, HubSpotApi } from './types'
import { quickbooksClient, type QuickBooksApi, type QuickBooksFullApi } from './quickbooks'
import { salesforceClient, type SalesforceApi } from './salesforce'
import { pipedriveClient, type PipedriveApi } from './pipedrive'
import { zohoClient, type ZohoApi } from './zoho'
import { hubspotCrm } from '../crm/hubspot'
import type { CrmClient } from '../crm/types'
import { buildiumClient, decodeBuildiumKey, BUILDIUM_API, BUILDIUM_SANDBOX_API, type BuildiumApi } from '../buildium/client'
import { OfficeAuthError } from './credentials'
import { syntheticQuickBooks } from './quickbooks-synthetic'
import { countWorkflow } from '../ai/meter'

/**
 * Workflow cost (lib/ai/meter.ts): each client asks for the access token once per API request, so counting
 * there counts every real HubSpot, Calendar and QuickBooks call per organization (synthetic ones are free).
 */
type Metered = { org_id?: string }
type Connector = 'hubspot' | 'google_calendar' | 'quickbooks' | 'salesforce' | 'pipedrive' | 'zoho_crm' | 'buildium'
const meteredToken = (c: { id: string } & Metered, connector: Connector) => () => {
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
  return c.is_synthetic ? syntheticQuickBooks(c.id) : quickbooksClient(meteredToken(c, 'quickbooks'), c.external_account_id, { refresh: rejected => officeAccessToken(c.id, new Date(), { force: true, rejected }) })
}

/** QuickBooks with the launch-build writes and change feed (real connections only). */
export function quickbooksWriterFor(c: Pick<OfficeConnectionRow, 'id' | 'provider' | 'is_synthetic' | 'external_account_id'> & Metered): QuickBooksFullApi {
  if (c.provider !== 'quickbooks' || c.is_synthetic) throw new Error('not a real QuickBooks connection')
  return quickbooksClient(meteredToken(c, 'quickbooks'), c.external_account_id, { refresh: rejected => officeAccessToken(c.id, new Date(), { force: true, rejected }) })
}

type Bound = Pick<OfficeConnectionRow, 'id' | 'provider' | 'is_synthetic' | 'api_base'> & Metered
const tokens = (c: Bound & { id: string }, connector: Connector) => officeTokenSource(c.id, () => countWorkflow(c.org_id, 'provider_call', connector))
const bound = (c: Bound) => { if (!c.api_base) throw new OfficeAuthError('the connection does not say which server it is on; reconnect it'); return c.api_base }

export function salesforceFor(c: Bound): SalesforceApi { if (c.provider !== 'salesforce') throw new Error('not a Salesforce connection'); return salesforceClient(tokens(c, 'salesforce'), bound(c)) }
export function pipedriveFor(c: Bound): PipedriveApi { if (c.provider !== 'pipedrive') throw new Error('not a Pipedrive connection'); return pipedriveClient(tokens(c, 'pipedrive'), bound(c)) }
export function zohoFor(c: Bound): ZohoApi { if (c.provider !== 'zoho_crm') throw new Error('not a Zoho CRM connection'); return zohoClient(tokens(c, 'zoho_crm'), bound(c)) }

/** The same CRM contract whichever CRM the organization connected (packs call this, never a provider directly). */
export function crmFor(c: Bound): CrmClient {
  switch (c.provider) {
    case 'hubspot': if (c.is_synthetic) throw new Error('the synthetic HubSpot provider does not implement the CRM contract'); return hubspotCrm(tokens(c, 'hubspot'))
    case 'salesforce': return salesforceFor(c)
    case 'pipedrive': return pipedriveFor(c)
    case 'zoho_crm': return zohoFor(c)
    default: throw new Error('not a CRM connection')
  }
}

/** Buildium for a connection: the API key is decrypted per request; the environment (production or sandbox) is the one it was connected on. */
export function buildiumFor(c: Bound): BuildiumApi {
  if (c.provider !== 'buildium') throw new Error('not a Buildium connection')
  const base = c.api_base === new URL(BUILDIUM_SANDBOX_API).origin ? BUILDIUM_SANDBOX_API : BUILDIUM_API
  const key = meteredToken(c, 'buildium')
  return buildiumClient(async () => decodeBuildiumKey(await key()), base)
}
