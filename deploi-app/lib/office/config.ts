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
  // Salesforce (connected app, OAuth 2.0 web server flow + PKCE). SALESFORCE_LOGIN_URL: https://test.salesforce.com for a sandbox org
  get salesforceClientId() { return e('SALESFORCE_CLIENT_ID') },
  get salesforceClientSecret() { return e('SALESFORCE_CLIENT_SECRET') },
  get salesforceConfigured() { return Boolean(this.salesforceClientId && this.salesforceClientSecret) },
  get salesforceRedirectUrl() { return e('SALESFORCE_REDIRECT_URL') || `${appUrl()}/api/office/oauth/salesforce/callback` },
  get salesforceLoginUrl() { const v = e('SALESFORCE_LOGIN_URL'); return v === 'https://test.salesforce.com' ? v : 'https://login.salesforce.com' },
  get salesforceApiVersion() { return /^v\d{2}\.0$/.test(e('SALESFORCE_API_VERSION')) ? e('SALESFORCE_API_VERSION') : 'v62.0' },
  // Pipedrive (Marketplace app, OAuth 2.0)
  get pipedriveClientId() { return e('PIPEDRIVE_CLIENT_ID') },
  get pipedriveClientSecret() { return e('PIPEDRIVE_CLIENT_SECRET') },
  get pipedriveConfigured() { return Boolean(this.pipedriveClientId && this.pipedriveClientSecret) },
  get pipedriveRedirectUrl() { return e('PIPEDRIVE_REDIRECT_URL') || `${appUrl()}/api/office/oauth/pipedrive/callback` },
  // Zoho CRM (API console server-based client, OAuth 2.0; the data center comes back on the callback)
  get zohoClientId() { return e('ZOHO_CLIENT_ID') },
  get zohoClientSecret() { return e('ZOHO_CLIENT_SECRET') },
  get zohoConfigured() { return Boolean(this.zohoClientId && this.zohoClientSecret) },
  get zohoRedirectUrl() { return e('ZOHO_REDIRECT_URL') || `${appUrl()}/api/office/oauth/zoho/callback` },
  /** the accounts server the consent starts on: com (default), eu, in or com.au; the customer's own data center is used after the callback */
  get zohoDefaultDc() { const v = e('ZOHO_DEFAULT_DC'); return v === 'eu' || v === 'in' || v === 'com.au' ? v : 'com' },
  // Buildium (API key per customer: the customer creates a client id + secret in Buildium; nothing global is needed)
  /** 'sandbox' sends Buildium calls to apisandbox.buildium.com */
  get buildiumSandbox() { return e('BUILDIUM_ENVIRONMENT') === 'sandbox' },
  /** API keys are the customer's own: Buildium is available unless BUILDIUM_ENABLED=off */
  get buildiumConfigured() { return e('BUILDIUM_ENABLED') !== 'off' },
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

export type OfficeProvider = 'hubspot' | 'google_calendar' | 'quickbooks' | 'salesforce' | 'pipedrive' | 'zoho_crm' | 'buildium'
/** the providers connected through an OAuth consent (Buildium takes an API key instead) */
export type OfficeOAuthProvider = Exclude<OfficeProvider, 'buildium'>
/** the original three, which also have synthetic test providers */
export type SyntheticOfficeProvider = 'hubspot' | 'google_calendar' | 'quickbooks'
export const isSyntheticProvider = (p: OfficeProvider): p is SyntheticOfficeProvider => p === 'hubspot' || p === 'google_calendar' || p === 'quickbooks'
export const CRM_PROVIDERS = ['hubspot', 'salesforce', 'pipedrive', 'zoho_crm'] as const
export type CrmProvider = (typeof CRM_PROVIDERS)[number]
export const isCrmProvider = (p: unknown): p is CrmProvider => (CRM_PROVIDERS as readonly unknown[]).includes(p)
export const OFFICE_PROVIDERS: OfficeProvider[] = ['hubspot', 'salesforce', 'pipedrive', 'zoho_crm', 'google_calendar', 'quickbooks', 'buildium']
export const PROVIDER_LABEL: Record<OfficeProvider, string> = { hubspot: 'HubSpot CRM', google_calendar: 'Google Calendar', quickbooks: 'QuickBooks Online', salesforce: 'Salesforce', pipedrive: 'Pipedrive', zoho_crm: 'Zoho CRM', buildium: 'Buildium' }
export const providerConfigured = (p: OfficeProvider): boolean => {
  switch (p) {
    case 'hubspot': return officeConfig.hubspotConfigured
    case 'quickbooks': return officeConfig.quickbooksConfigured
    case 'google_calendar': return officeConfig.googleConfigured
    case 'salesforce': return officeConfig.salesforceConfigured
    case 'pipedrive': return officeConfig.pipedriveConfigured
    case 'zoho_crm': return officeConfig.zohoConfigured
    case 'buildium': return officeConfig.buildiumConfigured
  }
}
