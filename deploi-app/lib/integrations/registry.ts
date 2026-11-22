/**
 * The integration hub: one model of every integration Deploi connects to, for the customer's Integrations
 * page, the staff diagnostics view and the hourly connection.health job.
 *
 * For each integration: its key and suite, how it authorizes, the scopes it asks for and why, the
 * environment variables it needs, its setup document, and
 *   - connections(db, org | null)  its connection rows (one table per provider family), normalised
 *   - status(db, org)              connected / needs_reauth / error / not_connected / not_configured, with
 *                                  the last successful call and the last error (lib/integrations/events.ts)
 *   - connect / reconnect / disconnect, reusing the existing flows (Shopify install, WooCommerce key
 *     authorization, Office OAuth, mailbox OAuth); a reconnection keeps the connection's id
 *   - test(db, org)                a safe read-only probe per connection (lib/integrations/probes.ts)
 *
 * Nothing here returns a credential. Environment variable names are only ever shown to staff
 * (customerView() removes them and turns "not configured" into "Not available yet").
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import type { Actor } from '../engine/actor'
import { assertMerchant } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { assertCan } from '../platform/rbac'
import { REQUIRED_SCOPES as SHOPIFY_REQUIRED, OPTIONAL_SCOPES as SHOPIFY_OPTIONAL, shopifyConfig } from '../connectors/shopify/config'
import { HUBSPOT_SCOPES } from '../office/hubspot'
import { CAL_EVENTS, CAL_FREEBUSY } from '../office/calendar'
import { QBO_SCOPES } from '../office/quickbooks'
import { GMAIL_READ, GMAIL_SEND } from '../email/adapters/gmail'
import { MS_CALENDAR, MS_MAIL_RW, MS_READ, MS_SEND } from '../email/adapters/microsoft'
import { SALESFORCE_SCOPES } from '../office/salesforce'
import { PIPEDRIVE_SCOPES } from '../office/pipedrive'
import { ZOHO_SCOPES } from '../office/zoho'
import { officeConfig } from '../office/config'
import { connectSyntheticOffice, disconnectOffice, startOfficeConnect } from '../office/connections'
import { mutateOfficeSynth } from '../office/synthetic'
import { mutateQboSynth } from '../office/quickbooks-synthetic'
import { disconnectAccount, startConnect } from '../email/accounts'
import { disconnectStore } from '../connectors/woocommerce/connect'
import { callbackUrl, startAuthorization } from '../connectors/woocommerce/auth'
import { recordReconnected, type HealthStateRow } from './events'
import type { ConnRef } from './probes'
import { connectionStatus, rowStatus } from './status'
import { probeAndRecord } from './check'
import { STATUS_WORDS, type TestOutcome, type AuthKind, type ConnectionView, type HealthStatus, type IntegrationKey, type IntegrationView, type ScopeExplained, type Suite, type WebhookSupport } from './types'

export type EnvVar = { name: string; required: boolean; purpose: string; valid?: (v: string) => boolean }

export type IntegrationDef = {
  key: IntegrationKey; name: string; suite: Suite; authKind: AuthKind
  usedFor: string; permissions: string[]; scopes: ScopeExplained[]; env: EnvVar[]; docs: string
  /** where the customer connects it today */
  connectHref: string
  webhooks: WebhookSupport
  /** probed by the hourly connection.health job */
  monitored: boolean
  /** a broken connection can be restored by the customer through a reconnection */
  reconnectable: boolean
  disconnectable: boolean
  connections(db: Db, orgId: string | null): Promise<ConnRef[]>
}

const env = (k: string) => (process.env[k] ?? '').trim()
const KEY = { name: 'CREDENTIALS_ENCRYPTION_KEY', required: true, purpose: 'encrypts every stored token and key (base64 of 32 bytes)' }

type Row = { id: string; org_id: string; label: string; status: string; reason: string | null; synthetic: boolean; external: string; connected_at: string | null }
const refs = (integration: IntegrationKey, rows: Row[]): ConnRef[] => rows.map(r => ({ integration, id: r.id, orgId: r.org_id, label: r.label, rawStatus: r.status, reason: r.reason, synthetic: r.synthetic, external: r.external, connectedAt: r.connected_at }))

const storeRows = (platform: 'shopify' | 'woocommerce') => async (db: Db, orgId: string | null) => refs(platform, await db.query<Row>(
  `select id, org_id, coalesce(display_name, external_id) as label, status, status_reason as reason, is_synthetic as synthetic, external_id as external, installed_at::text as connected_at
   from store_connections where platform = $1 and status in ('active', 'error', 'pending') and ($2::uuid is null or org_id = $2) order by created_at`, [platform, orgId]))

type OfficeKey = 'hubspot' | 'google_calendar' | 'quickbooks' | 'salesforce' | 'pipedrive' | 'zoho_crm' | 'buildium'
const OFFICE_KEYS: readonly IntegrationKey[] = ['hubspot', 'google_calendar', 'quickbooks', 'salesforce', 'pipedrive', 'zoho_crm', 'buildium']
const isOfficeKey = (k: IntegrationKey): k is OfficeKey => OFFICE_KEYS.includes(k)
const officeRows = (provider: OfficeKey) => async (db: Db, orgId: string | null) => refs(provider, await db.query<Row>(
  `select id, org_id, coalesce(display_name, external_account_id) as label, status, status_reason as reason, is_synthetic as synthetic, external_account_id as external, connected_at::text as connected_at
   from office_connections where provider = $1 and status <> 'disconnected' and ($2::uuid is null or org_id = $2) order by connected_at`, [provider, orgId]))

const mailRows = (provider: 'gmail' | 'microsoft' | 'deploi', key: IntegrationKey) => async (db: Db, orgId: string | null) => refs(key, await db.query<Row>(
  `select id, org_id, address as label, status, status_reason as reason, is_synthetic as synthetic, address as external, connected_at::text as connected_at
   from email_accounts where provider = $1 and status <> 'disconnected' and ($2::uuid is null or org_id = $2) order by connected_at`, [provider, orgId]))

export const INTEGRATIONS: IntegrationDef[] = [
  {
    key: 'shopify', name: 'Shopify', suite: 'commerce', authKind: 'app_install', docs: 'docs/SHOPIFY-SETUP.md', connectHref: '/store/connect', webhooks: 'reregister', monitored: true, reconnectable: true, disconnectable: false,
    usedFor: 'Deploi Commerce reads products and inventory to find stock and listing problems.',
    permissions: ['Read products, variants, inventory and locations', 'Write products and publications only for an agent you widen past drafts only'],
    scopes: [
      ...SHOPIFY_REQUIRED.map(s => ({ scope: s, why: s === 'read_products' ? 'read products and variants to check listings, prices and SKUs' : s === 'read_inventory' ? 'read stock levels to find oversold and low-stock items' : 'read locations so stock is counted where it is held' })),
      ...SHOPIFY_OPTIONAL.map(s => ({ scope: s, why: s === 'write_products' ? 'asked for only when you let an agent correct products (prices, SKUs, oversell policy)' : s === 'read_publications' ? 'asked for only to check where products are published' : 'asked for only when you let an agent publish or unpublish products' })),
    ],
    env: [{ name: 'SHOPIFY_API_KEY', required: true, purpose: 'the app\'s client id (Partner Dashboard)' }, { name: 'SHOPIFY_API_SECRET', required: true, purpose: 'the app\'s client secret: verifies session tokens and webhooks' }, KEY,
      { name: 'SHOPIFY_API_VERSION', required: false, purpose: 'pinned Admin API version (default 2026-10)' }],
    connections: storeRows('shopify'),
  },
  {
    key: 'woocommerce', name: 'WooCommerce', suite: 'commerce', authKind: 'api_key', docs: 'docs/WOOCOMMERCE-SETUP.md', connectHref: '/store/connect/woocommerce', webhooks: 'reregister', monitored: true, reconnectable: true, disconnectable: true,
    usedFor: 'Deploi Commerce for WooCommerce stores: the same checks and the same permission levels.',
    permissions: ['Read products and stock', 'Write only what an agent you widen past drafts only is granted'],
    scopes: [{ scope: 'read', why: 'read products, variations and stock (every write is checked with a read before and after)' }, { scope: 'write', why: 'used only for changes an agent you widened past drafts only is granted, and to register webhooks' }],
    env: [KEY, { name: 'NEXT_PUBLIC_APP_URL', required: false, purpose: 'must be https for the one-click key approval and for webhooks', valid: v => v.startsWith('https://') }],
    connections: storeRows('woocommerce'),
  },
  {
    key: 'hubspot', name: 'HubSpot', suite: 'office', authKind: 'oauth2', docs: 'docs/OFFICE-SETUP.md', connectHref: '/office/connections', webhooks: 'none', monitored: true, reconnectable: true, disconnectable: true,
    usedFor: 'Deploi Office follows up new leads and keeps contact records current.',
    permissions: ['Read contacts and deals', 'Draft follow-ups; writing back needs your grant'],
    scopes: HUBSPOT_SCOPES.map(s => ({ scope: s, why: s.endsWith('contacts.read') ? 'find new leads and read their status' : s.endsWith('contacts.write') ? 'log notes and tasks on a contact, update its stage, only as you grant' : s.endsWith('deals.read') ? 'see a lead\'s deals' : 'move a deal stage, only as you grant' })),
    env: [{ name: 'HUBSPOT_CLIENT_ID', required: true, purpose: 'HubSpot public app client id' }, { name: 'HUBSPOT_CLIENT_SECRET', required: true, purpose: 'HubSpot public app client secret' }, KEY,
      { name: 'HUBSPOT_REDIRECT_URL', required: false, purpose: 'OAuth redirect (default <app>/api/office/oauth/hubspot/callback)' }],
    connections: officeRows('hubspot'),
  },
  {
    key: 'google_calendar', name: 'Google Calendar', suite: 'office', authKind: 'oauth2_pkce', docs: 'docs/OFFICE-SETUP.md', connectHref: '/office/connections', webhooks: 'none', monitored: true, reconnectable: true, disconnectable: true,
    usedFor: 'Deploi Office proposes meeting times from your free and busy slots and books what you approve.',
    permissions: ['Read free and busy times', 'Create events only for bookings you approve or grant'],
    scopes: [{ scope: CAL_FREEBUSY, why: 'see when you are busy (never event titles or attendees)' }, { scope: CAL_EVENTS, why: 'create, move or cancel the events Deploi books on calendars you own' }, { scope: 'openid email', why: 'show which Google account is connected' }],
    env: [{ name: 'GOOGLE_CALENDAR_CLIENT_ID', required: true, purpose: 'Google OAuth client id' }, { name: 'GOOGLE_CALENDAR_CLIENT_SECRET', required: true, purpose: 'Google OAuth client secret' }, KEY],
    connections: officeRows('google_calendar'),
  },
  {
    key: 'quickbooks', name: 'QuickBooks Online', suite: 'office', authKind: 'oauth2', docs: 'docs/QUICKBOOKS-SETUP.md', connectHref: '/office/connections', webhooks: 'portal', monitored: true, reconnectable: true, disconnectable: true,
    usedFor: 'The Accounts Receivable agent reads open invoices and payments to follow up overdue invoices, and notices changes within minutes.',
    permissions: ['Read invoices, payments, customers and the company name', 'Create an invoice, record a payment or send an invoice only for actions you approve or grant'],
    scopes: QBO_SCOPES.map(s => ({ scope: s, why: 'read invoices and payments; create invoices, record payments and send invoices only as you approve (Intuit\'s only Accounting scope)' })),
    env: [{ name: 'QUICKBOOKS_CLIENT_ID', required: true, purpose: 'Intuit app client id' }, { name: 'QUICKBOOKS_CLIENT_SECRET', required: true, purpose: 'Intuit app client secret' }, KEY,
      { name: 'QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN', required: false, purpose: 'verifies Intuit webhook deliveries (without it updates wait for the next read)' },
      { name: 'QUICKBOOKS_ENVIRONMENT', required: false, purpose: '"sandbox" for Intuit sandbox companies' }],
    connections: officeRows('quickbooks'),
  },
  {
    key: 'salesforce', name: 'Salesforce', suite: 'office', authKind: 'oauth2_pkce', docs: 'docs/CONNECTIONS.md', connectHref: '/office/connections', webhooks: 'none', monitored: true, reconnectable: true, disconnectable: true,
    usedFor: 'Agents find and update leads and contacts, log tasks and notes, and move opportunity stages in your Salesforce org.',
    permissions: ['Read leads, contacts, opportunities and tasks', 'Create or update them only for actions you approve or grant'],
    scopes: SALESFORCE_SCOPES.map(s => ({ scope: s, why: s === 'api' ? 'read and write leads, contacts, opportunities, tasks and notes through the REST API' : 'stay connected without signing in again (refresh token)' })),
    env: [{ name: 'SALESFORCE_CLIENT_ID', required: true, purpose: 'connected app consumer key' }, { name: 'SALESFORCE_CLIENT_SECRET', required: true, purpose: 'connected app consumer secret' }, KEY,
      { name: 'SALESFORCE_LOGIN_URL', required: false, purpose: 'https://test.salesforce.com to connect sandbox orgs (default login.salesforce.com)' },
      { name: 'SALESFORCE_REDIRECT_URL', required: false, purpose: 'OAuth callback (default <app>/api/office/oauth/salesforce/callback)' }],
    connections: officeRows('salesforce'),
  },
  {
    key: 'pipedrive', name: 'Pipedrive', suite: 'office', authKind: 'oauth2', docs: 'docs/CONNECTIONS.md', connectHref: '/office/connections', webhooks: 'none', monitored: true, reconnectable: true, disconnectable: true,
    usedFor: 'Agents find and update people, log activities and notes, and move deal stages in Pipedrive.',
    permissions: ['Read people, deals and activities', 'Create or update them only for actions you approve or grant'],
    scopes: PIPEDRIVE_SCOPES.map(s => ({ scope: s, why: s.startsWith('contacts') ? 'find, create and update people' : s.startsWith('deals') ? 'read deals and move their stage' : s.startsWith('activities') ? 'create and complete follow-up activities' : 'show which company is connected' })),
    env: [{ name: 'PIPEDRIVE_CLIENT_ID', required: true, purpose: 'Pipedrive app client id (Developer Hub)' }, { name: 'PIPEDRIVE_CLIENT_SECRET', required: true, purpose: 'Pipedrive app client secret' }, KEY,
      { name: 'PIPEDRIVE_REDIRECT_URL', required: false, purpose: 'OAuth callback (default <app>/api/office/oauth/pipedrive/callback)' }],
    connections: officeRows('pipedrive'),
  },
  {
    key: 'zoho_crm', name: 'Zoho CRM', suite: 'office', authKind: 'oauth2', docs: 'docs/CONNECTIONS.md', connectHref: '/office/connections', webhooks: 'none', monitored: true, reconnectable: true, disconnectable: true,
    usedFor: 'Agents find and update leads and contacts, log tasks and notes, and move deal stages in Zoho CRM (US, EU, India or Australia data center).',
    permissions: ['Read leads, contacts and deals', 'Create or update them only for actions you approve or grant'],
    scopes: ZOHO_SCOPES.map(s => ({ scope: s, why: s.includes('org') ? 'show which Zoho organization is connected' : `read and write ${s.split('.')[2]}, only as you grant` })),
    env: [{ name: 'ZOHO_CLIENT_ID', required: true, purpose: 'Zoho API console client id (server-based application)' }, { name: 'ZOHO_CLIENT_SECRET', required: true, purpose: 'Zoho API console client secret' }, KEY,
      { name: 'ZOHO_DEFAULT_DC', required: false, purpose: 'where sign-in starts: com (default), eu, in or com.au; the customer\'s own data center is used after' },
      { name: 'ZOHO_REDIRECT_URL', required: false, purpose: 'OAuth callback (default <app>/api/office/oauth/zoho/callback)' }],
    connections: officeRows('zoho_crm'),
  },
  {
    key: 'buildium', name: 'Buildium', suite: 'office', authKind: 'api_key', docs: 'docs/CONNECTIONS.md', connectHref: '/office/connections', webhooks: 'none', monitored: true, reconnectable: true, disconnectable: true,
    usedFor: 'Property management agents read properties, units, leases, tenants, rental applications and work orders, and notice changes within minutes.',
    permissions: ['Read properties, units, leases, tenants, applications and work orders', 'Create work orders, update their status or an application\'s status only for actions you approve or grant'],
    scopes: [{ scope: 'API key (client ID and secret)', why: 'created by you in Buildium under Settings, Application settings, API settings; give it read and write access to Rentals, Leasing, Applicants and Tasks' }],
    env: [KEY, { name: 'BUILDIUM_ENVIRONMENT', required: false, purpose: '"sandbox" to connect Buildium sandbox accounts (apisandbox.buildium.com)' },
      { name: 'BUILDIUM_ENABLED', required: false, purpose: '"off" hides Buildium in this deployment' }],
    connections: officeRows('buildium'),
  },
  {
    key: 'agent_mailbox', name: 'Deploi Email (agent mailboxes)', suite: 'email', authKind: 'platform_key', docs: 'docs/EMAIL-SETUP.md', connectHref: '/store/connections', webhooks: 'none', monitored: false, reconnectable: false, disconnectable: false,
    usedFor: 'Each agent with email tasks writes from its own address on Deploi\'s domain.',
    permissions: ['Draft email for your review (default)', 'Send only what you approve, or within limits you grant'],
    scopes: [],
    env: [{ name: 'AGENT_MAIL_DOMAIN', required: true, purpose: 'the verified sending domain for agent addresses' }, { name: 'RESEND_API_KEY', required: true, purpose: 'sends agent mail' },
      { name: 'AGENT_MAIL_WEBHOOK_SECRET', required: false, purpose: 'verifies inbound mail deliveries' }, { name: 'EMAIL_LIVE_SENDS', required: false, purpose: 'off (default), allowlist or all' }],
    connections: mailRows('deploi', 'agent_mailbox'),
  },
  {
    key: 'gmail', name: 'Gmail / Google Workspace', suite: 'email', authKind: 'oauth2_pkce', docs: 'docs/EMAIL-SETUP.md', connectHref: '/store/connections', webhooks: 'none', monitored: true, reconnectable: true, disconnectable: true,
    usedFor: 'Agents send approved email from your own address instead of their Deploi mailbox.',
    permissions: ['Send email you approve (one at a time, unless you grant more)', 'Read replies to messages an agent sent, only when a task needs it'],
    scopes: [{ scope: GMAIL_SEND, why: 'send the messages you approve' }, { scope: GMAIL_READ, why: 'only if you allow it: notice replies to messages an agent sent' }, { scope: 'openid email profile', why: 'show which account is connected' }],
    env: [{ name: 'EMAIL_OAUTH_PROVIDERS', required: true, purpose: 'must be "on": Gmail and Microsoft are off by default (not live-verified)', valid: v => v === 'on' },
      { name: 'GOOGLE_OAUTH_CLIENT_ID', required: true, purpose: 'Google OAuth client id for mail' }, { name: 'GOOGLE_OAUTH_CLIENT_SECRET', required: true, purpose: 'Google OAuth client secret for mail' }, KEY],
    connections: mailRows('gmail', 'gmail'),
  },
  {
    key: 'microsoft', name: 'Microsoft 365 / Outlook', suite: 'email', authKind: 'oauth2_pkce', docs: 'docs/EMAIL-SETUP.md', connectHref: '/store/connections', webhooks: 'none', monitored: true, reconnectable: true, disconnectable: true,
    usedFor: 'Agents send approved email from your own address, read new mail (including Zillow, Apartments.com and Zumper lead emails) and, when you connect the calendar too, book and move meetings.',
    permissions: ['Send email you approve (one at a time, unless you grant more)', 'Read new mail and calendar changes when you connect them', 'Create or move calendar events only for actions you approve or grant'],
    scopes: [{ scope: MS_SEND, why: 'send the messages you approve' }, { scope: MS_READ, why: 'only if you allow it: notice replies to messages an agent sent' },
      { scope: MS_MAIL_RW, why: 'with mail and calendar: read new mail (to spot leads and requests) and file replies in their conversation' },
      { scope: MS_CALENDAR, why: 'with mail and calendar: see your events, and create or move the ones you approve' }, { scope: 'offline_access User.Read', why: 'stay connected and show which account is connected' }],
    env: [{ name: 'EMAIL_OAUTH_PROVIDERS', required: true, purpose: 'must be "on": Gmail and Microsoft are off by default (not live-verified)', valid: v => v === 'on' },
      { name: 'MICROSOFT_OAUTH_CLIENT_ID', required: true, purpose: 'Microsoft Entra app client id' }, { name: 'MICROSOFT_OAUTH_CLIENT_SECRET', required: true, purpose: 'Microsoft Entra app client secret' }, KEY],
    connections: mailRows('microsoft', 'microsoft'),
  },
  {
    key: 'stripe', name: 'Stripe billing', suite: 'billing', authKind: 'platform_key', docs: 'docs/DEPLOY.md', connectHref: '/store/billing', webhooks: 'readonly', monitored: false, reconnectable: false, disconnectable: false,
    usedFor: 'Your Deploi subscription. Agents never use it.',
    permissions: ['None for agents', 'You approve every charge'],
    scopes: [],
    env: [{ name: 'BILLING_MODE', required: true, purpose: '"test" or "live" (off by default: nothing is charged)', valid: v => v === 'test' || v === 'live' },
      { name: 'STRIPE_SECRET_KEY', required: true, purpose: 'Stripe secret or restricted key' }, { name: 'STRIPE_WEBHOOK_SECRET', required: true, purpose: 'signing secret of /api/billing/stripe/webhook' }],
    async connections(db, orgId) {
      return refs('stripe', await db.query<Row>(`select id, org_id, 'Billing account' as label, 'active' as status, null as reason, false as synthetic, external_id as external, created_at::text as connected_at
        from billing_customers where external_id ~ '^cus_[A-Za-z0-9]+$' and ($1::uuid is null or org_id = $1)`, [orgId]))
    },
  },
]

const BY_KEY = new Map(INTEGRATIONS.map(d => [d.key, d]))
export function integrationDef(key: IntegrationKey): IntegrationDef {
  const d = BY_KEY.get(key)
  if (!d) throw new EngineError('not_found', 'unknown integration')
  return d
}

/** Environment variables this deployment is missing for an integration (staff only). */
export function missingEnv(def: IntegrationDef): string[] {
  return def.env.filter(v => v.required && (!env(v.name) || (v.valid ? !v.valid(env(v.name)) : false))).map(v => v.name)
}
export const configured = (def: IntegrationDef) => missingEnv(def).length === 0

// ---------------------------------------------------------------- status

const RANK: Record<HealthStatus, number> = { needs_reauth: 4, error: 3, connected: 2, not_connected: 1, not_configured: 0 }
const latest = (xs: (string | null)[]) => xs.filter((x): x is string => Boolean(x)).sort().at(-1) ?? null

function detailFor(def: IntegrationDef, status: HealthStatus, conns: ConnectionView[]): string {
  const names = conns.map(c => `${c.label}${c.synthetic ? ' (synthetic test account)' : ''}`).join(', ')
  if (status === 'not_configured') return 'Not available in this deployment yet.'
  if (status === 'not_connected') return def.key === 'agent_mailbox' ? 'An agent gets its own address when it has an email task.' : 'Available, not connected.'
  const bad = conns.find(c => c.status === status)
  if (status === 'needs_reauth') return `${bad?.label ?? names}: reconnect to restore it${bad?.reason ? ` (${bad.reason})` : ''}.`
  if (status === 'error') return `${bad?.label ?? names}: not working${bad?.reason ? ` (${bad.reason})` : ''}.`
  return names
}

export async function statusOf(db: Db, def: IntegrationDef, orgId: string): Promise<IntegrationView> {
  const conns = await def.connections(db, orgId)
  const states = conns.length ? await db.query<HealthStateRow>(`select * from connection_health_state where integration = $1 and connection_id = any($2::uuid[])`, [def.key, conns.map(c => c.id)]) : []
  const views = conns.map(c => connectionStatus(c, states.find(s => s.connection_id === c.id) ?? null))
  const status: HealthStatus = views.length ? views.map(v => v.status).sort((a, b) => RANK[b] - RANK[a])[0] : configured(def) ? 'not_connected' : 'not_configured'
  const errs = views.filter(v => v.lastError).sort((a, b) => String(b.lastError!.at).localeCompare(String(a.lastError!.at)))
  const synthetic = def.key === 'hubspot' || def.key === 'google_calendar' || def.key === 'quickbooks' ? officeConfig.syntheticAllowed : false
  const sandboxOnly = (def.key === 'quickbooks' && officeConfig.quickbooksSandbox) || (def.key === 'buildium' && officeConfig.buildiumSandbox) || (def.key === 'salesforce' && officeConfig.salesforceLoginUrl === 'https://test.salesforce.com')
  return {
    key: def.key, name: def.name, suite: def.suite, authKind: def.authKind, usedFor: def.usedFor, permissions: def.permissions, scopes: def.scopes, docs: def.docs, liveVerified: false, sandboxOnly,
    status, detail: detailFor(def, status, views),
    lastCheckedAt: latest(views.map(v => v.lastCheckedAt)), lastSuccessAt: latest(views.map(v => v.lastSuccessAt)), lastError: errs[0]?.lastError ?? null,
    connections: views,
    can: {
      connect: status !== 'not_configured' || synthetic, reconnect: def.reconnectable && views.some(v => v.status === 'needs_reauth' || v.status === 'error'),
      disconnect: def.disconnectable && views.length > 0, test: views.length > 0, webhooks: def.webhooks, synthetic,
    },
    connectHref: def.connectHref,
    missingEnv: missingEnv(def),
  }
}

/** Every integration for one organization (service-role reads, always filtered by the organization). */
export async function integrationStatuses(orgId: string): Promise<IntegrationView[]> {
  return admin(async db => { const out: IntegrationView[] = []; for (const d of INTEGRATIONS) out.push(await statusOf(db, d, orgId)); return out })
}

/** Environment variable names never reach a customer: they are removed, and any that slipped into a message become "a setting". */
const ENV_NAMES = [...new Set(INTEGRATIONS.flatMap(d => d.env.map(v => v.name)))]
export function scrubEnvNames(s: string): string {
  let out = s
  for (const n of ENV_NAMES) out = out.split(n).join('a setting')
  return out.replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/g, 'a setting')
}
export function customerView(v: IntegrationView): IntegrationView {
  const { missingEnv: _m, ...rest } = v
  void _m
  const scrubConn = (c: ConnectionView): ConnectionView => ({ ...c, reason: c.reason ? scrubEnvNames(c.reason) : null, lastError: c.lastError ? { ...c.lastError, message: scrubEnvNames(c.lastError.message) } : null })
  return { ...rest, detail: scrubEnvNames(rest.detail), lastError: rest.lastError ? { ...rest.lastError, message: scrubEnvNames(rest.lastError.message) } : null, connections: rest.connections.map(scrubConn) }
}

export const statusWords = (s: HealthStatus) => STATUS_WORDS[s]

// ---------------------------------------------------------------- test

/**
 * Test: the read-only probe of every connection the organization has for this integration, recorded in the
 * health history (trigger manual). Returns a human-readable result per connection.
 */
export async function testIntegration(orgId: string, key: IntegrationKey, opts: { now?: Date; timeoutMs?: number } = {}): Promise<{ status: HealthStatus; message: string; results: TestOutcome[] }> {
  const def = integrationDef(key)
  const conns = await admin(db => def.connections(db, orgId))
  if (!conns.length) {
    const status: HealthStatus = configured(def) ? 'not_connected' : 'not_configured'
    return { status, message: status === 'not_configured' ? `${def.name} is not available in this deployment yet.` : `Nothing to test: ${def.name} is not connected.`, results: [] }
  }
  const results: TestOutcome[] = []
  for (const c of conns) results.push(await probeAndRecord(c, 'manual', opts))
  const view = await admin(db => statusOf(db, def, orgId))
  const okCount = results.filter(r => r.ok).length
  return { status: view.status, message: results.length === 1 ? results[0].message : `${okCount} of ${results.length} connections answered.`, results }
}

// ---------------------------------------------------------------- actions (existing flows)

export type ActionResult = { kind: 'redirect'; url: string } | { kind: 'link'; href: string; message: string } | { kind: 'done'; connectionId: string; message: string }

function merchant(actor: Actor): asserts actor is Exclude<Actor, { kind: 'staff' }> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'Deploi staff can view integrations but not connect or disconnect them for a customer')
  assertMerchant(actor, actor.orgId)
}

async function ownConnection(def: IntegrationDef, orgId: string, connectionId: string): Promise<ConnRef> {
  const c = (await admin(db => def.connections(db, orgId))).find(x => x.id === connectionId)
  if (!c) throw new EngineError('not_found', 'connection not found')
  return c
}

/** Connect: the existing page for each provider (Office providers can also connect a synthetic test account here). */
export async function connectIntegration(actor: Actor, key: IntegrationKey, opts: { synthetic?: boolean } = {}): Promise<ActionResult> {
  merchant(actor)
  const def = integrationDef(key)
  if (opts.synthetic && (key === 'hubspot' || key === 'google_calendar' || key === 'quickbooks')) {
    const row = await connectSyntheticOffice(actor, key)
    return { kind: 'done', connectionId: row.id, message: `${def.name} (synthetic test account) is connected.` }
  }
  if (!configured(def)) throw new EngineError('not_operational', `${def.name} is not available in this deployment yet`)
  return { kind: 'link', href: def.connectHref, message: `Connect ${def.name} on its setup page.` }
}

/**
 * Reconnect in place: the provider's consent (or key approval) runs again for the SAME connection, so its id,
 * the agents that use it and their cases are kept. Synthetic connections (tests and demos) are restored here.
 */
export async function reconnectIntegration(actor: Actor, key: IntegrationKey, connectionId: string): Promise<ActionResult> {
  merchant(actor)
  const def = integrationDef(key)
  if (!def.reconnectable) throw new EngineError('invalid_input', `${def.name} has nothing to reconnect`)
  const c = await ownConnection(def, actor.orgId, connectionId)
  await assertCan(actor, actor.orgId, 'connect')
  if (c.synthetic) return restoreSynthetic(actor, def, c)
  switch (key) {
    case 'hubspot': case 'google_calendar': case 'quickbooks': case 'salesforce': case 'pipedrive': case 'zoho_crm':
      // the same account comes back to the same row (saveConnection matches the external account)
      return { kind: 'redirect', url: (await startOfficeConnect(actor, key)).url }
    case 'buildium':
      return { kind: 'link', href: '/office/connections?reconnect=buildium', message: 'Paste a new Buildium API key for the same account; the connection keeps its history.' }
    case 'gmail': case 'microsoft': {
      // reconnecting never narrows what was granted: inbox reading and the calendar are asked for again when the account had them
      const acc = await admin(db => db.one<{ granted_scopes: string[] }>('select granted_scopes from email_accounts where id = $1', [c.id]))
      const scopes = (acc?.granted_scopes ?? []).map(x => x.toLowerCase())
      return { kind: 'redirect', url: (await startConnect(actor, { provider: key, accountId: c.id, returnTo: '/store/integrations', inbox: scopes.includes('mail.read') || scopes.includes('mail.readwrite'), calendar: scopes.includes('calendars.readwrite') })).url }
    }
    case 'woocommerce':
      if (callbackUrl().startsWith('https://')) {
        const a = await startAuthorization({ orgId: actor.orgId, actor: actor.label, profileId: actor.kind === 'profile' ? actor.session.uid : null, siteUrl: c.external })
        return { kind: 'redirect', url: a.authorizeUrl }
      }
      return { kind: 'link', href: `/store/connect/woocommerce?site=${encodeURIComponent(c.external)}`, message: 'Approve a new Read/Write key for the same store; the connection keeps its history.' }
    case 'shopify': {
      // opening the app from the Shopify admin runs token exchange again for the same shop (install.ts#ensureInstalled)
      const handle = c.external.replace(/\.myshopify\.com$/, '')
      return shopifyConfig.apiKey
        ? { kind: 'redirect', url: `https://admin.shopify.com/store/${encodeURIComponent(handle)}/apps/${encodeURIComponent(shopifyConfig.apiKey)}` }
        : { kind: 'link', href: '/store/connect', message: 'Open Deploi from your Shopify admin to renew the connection.' }
    }
    default:
      throw new EngineError('invalid_input', `${def.name} has nothing to reconnect`)
  }
}

/** Synthetic connections: the "provider" accepts the connection again (faults cleared), the row is reactivated, health restored. */
async function restoreSynthetic(actor: Exclude<Actor, { kind: 'staff' }>, def: IntegrationDef, c: ConnRef): Promise<ActionResult> {
  if (def.suite === 'office') {
    if (!officeConfig.syntheticAllowed) throw new EngineError('forbidden', 'synthetic connections are not available on this deployment')
    if (def.key === 'quickbooks') await mutateQboSynth(c.id, s => { s.faults = s.faults.filter(f => f.mode !== 'auth') })
    else await mutateOfficeSynth(c.id, s => { s.faults = s.faults.filter(f => f.mode !== 'auth') })
    // the same synthetic account: saveConnection updates the live row (same id) and records the reconnection
    const row = await connectSyntheticOffice(actor, def.key as 'hubspot' | 'google_calendar' | 'quickbooks', { demoData: false })
    return { kind: 'done', connectionId: row.id, message: `${def.name} is reconnected.` }
  }
  if (def.key === 'shopify' || def.key === 'woocommerce') {
    await admin(async db => {
      await db.query(`update store_connections set status = 'active', status_reason = null, reauth_required_at = null where id = $1 and org_id = $2 and is_synthetic`, [c.id, actor.orgId])
      await audit(db, { orgId: actor.orgId, connectionId: c.id, entityType: 'connection', entityId: c.id, event: 'connection.reauthorized', actor: actor.label, detail: { synthetic: true } })
      await recordReconnected(db, { orgId: actor.orgId, integration: def.key, connectionId: c.id, actor: actor.label, previous: rowStatus(c).status })
    })
    return { kind: 'done', connectionId: c.id, message: `${def.name} is reconnected.` }
  }
  throw new EngineError('invalid_input', `${def.name} has nothing to reconnect`)
}

/** Disconnect through the provider's own flow (tokens deleted, revoked where the provider allows, queued work cancelled). */
export async function disconnectIntegration(actor: Actor, key: IntegrationKey, connectionId: string): Promise<{ message: string }> {
  merchant(actor)
  const def = integrationDef(key)
  if (!def.disconnectable) throw new EngineError('invalid_input', key === 'shopify' ? 'Shopify is disconnected by uninstalling the Deploi app in your Shopify admin' : `${def.name} cannot be disconnected here`)
  await ownConnection(def, actor.orgId, connectionId)
  await assertCan(actor, actor.orgId, 'connect')
  if (isOfficeKey(key)) { const r = await disconnectOffice(actor, connectionId); return { message: `${def.name} is disconnected; ${r.actionsCancelled} queued action${r.actionsCancelled === 1 ? '' : 's'} cancelled.` } }
  if (key === 'gmail' || key === 'microsoft') { const r = await disconnectAccount(actor, connectionId); return { message: `${def.name} is disconnected; ${r.messagesCancelled} unsent message${r.messagesCancelled === 1 ? '' : 's'} cancelled.` } }
  if (key === 'woocommerce') { await disconnectStore(actor.orgId, connectionId, actor.label); return { message: 'WooCommerce is disconnected. Delete the key in WooCommerce > Settings > Advanced > REST API too.' } }
  throw new EngineError('invalid_input', `${def.name} cannot be disconnected here`)
}

