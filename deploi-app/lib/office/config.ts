/**
 * Deploi Office configuration from the environment. Nothing here has a secret default: without a
 * provider's client id and secret its connect button says "needs setup" and its APIs answer 503.
 */
const e = (k: string) => (process.env[k] ?? '').trim()
const appUrl = () => (e('APP_URL') || e('NEXT_PUBLIC_APP_URL') || 'http://localhost:3000').replace(/\/$/, '')

export const officeConfig = {
  get hubspotClientId() { return e('HUBSPOT_CLIENT_ID') },
  get hubspotClientSecret() { return e('HUBSPOT_CLIENT_SECRET') },
  get hubspotConfigured() { return Boolean(this.hubspotClientId && this.hubspotClientSecret) },
  get hubspotRedirectUrl() { return e('HUBSPOT_REDIRECT_URL') || `${appUrl()}/api/office/oauth/hubspot/callback` },
  get googleClientId() { return e('GOOGLE_CALENDAR_CLIENT_ID') },
  get googleClientSecret() { return e('GOOGLE_CALENDAR_CLIENT_SECRET') },
  get googleConfigured() { return Boolean(this.googleClientId && this.googleClientSecret) },
  get googleRedirectUrl() { return e('GOOGLE_CALENDAR_REDIRECT_URL') || `${appUrl()}/api/office/oauth/google/callback` },
  get quickbooksClientId() { return e('QUICKBOOKS_CLIENT_ID') },
  get quickbooksClientSecret() { return e('QUICKBOOKS_CLIENT_SECRET') },
  get quickbooksConfigured() { return Boolean(this.quickbooksClientId && this.quickbooksClientSecret) },
  get quickbooksRedirectUrl() { return e('QUICKBOOKS_REDIRECT_URL') || `${appUrl()}/api/office/oauth/quickbooks/callback` },
  /** 'sandbox' reads Intuit's sandbox companies (sandbox-quickbooks.api.intuit.com); anything else is production */
  get quickbooksSandbox() { return e('QUICKBOOKS_ENVIRONMENT') === 'sandbox' },
  /** QuickBooks Online API minor version sent with every request */
  get quickbooksMinorVersion() { return /^\d{1,3}$/.test(e('QUICKBOOKS_MINOR_VERSION')) ? e('QUICKBOOKS_MINOR_VERSION') : '75' },
  /** the webhook verifier token from the Intuit developer portal; without it the webhook endpoint answers 503 */
  get quickbooksWebhookVerifier() { return e('QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN') },
  /** synthetic HubSpot / Calendar connections: tests, local and preview demos only; never on a production deployment */
  get syntheticAllowed() { return e('NODE_ENV') !== 'production' || e('DEMO_CONTROLS') === 'true' || e('VERCEL_ENV') === 'preview' },
  /** bounded backoff on HTTP 429: attempts and the longest single wait */
  maxRetries: 3,
  maxRetryWaitMs: 10_000,
  /** refresh an access token this long before it expires */
  refreshSkewMs: 5 * 60_000,
  /** scheduler bounds */
  orgsPerRun: 25,
  actionsPerOrg: 25,
  leadsPerPoll: 100,
  pollPages: 5,
  lockLeaseMs: 4 * 60_000,
}

export type OfficeProvider = 'hubspot' | 'google_calendar' | 'quickbooks'
export const PROVIDER_LABEL: Record<OfficeProvider, string> = { hubspot: 'HubSpot CRM', google_calendar: 'Google Calendar', quickbooks: 'QuickBooks Online' }
export const providerConfigured = (p: OfficeProvider) => (p === 'hubspot' ? officeConfig.hubspotConfigured : p === 'quickbooks' ? officeConfig.quickbooksConfigured : officeConfig.googleConfigured)
