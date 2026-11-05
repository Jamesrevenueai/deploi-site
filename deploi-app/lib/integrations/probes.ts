/**
 * Read-only probes, one per integration: the smallest call that proves the connection works, through the
 * same clients the agents use (so the same approved hosts, fetch overrides in tests, token refresh and
 * workflow-cost metering apply). A probe never writes to a provider, never sends a message and never
 * returns a record's content: its message names what was read, not what it contained.
 *
 *   shopify          Admin GraphQL `shop { name }`; headroom from extensions.cost.throttleStatus
 *   woocommerce      REST GET /system_status (the WooCommerce version)
 *   hubspot          CRM GET /crm/v3/objects/contacts?limit=1 (no properties); headroom from X-HubSpot-RateLimit-*
 *   google_calendar  freeBusy for the next hour (busy times only)
 *   quickbooks       GET /companyinfo/{realmId} (the company name)
 *   gmail, microsoft the signed-in identity (OpenID userinfo / Graph /me)
 *   agent_mailbox    configuration only (no call: Resend has no read-only per-mailbox check)
 *   stripe           GET /v1/customers/{id} of the organization's billing customer
 */
import { admin } from '../db'
import { loadConnection } from '../engine/scan'
import { shopifyGraphql, ShopifyApiError, throttleStatusFor } from '../connectors/shopify/client'
import { Q_SHOP } from '../connectors/shopify/queries'
import { siteFor, wooRequest, WooApiError } from '../connectors/woocommerce/client'
import { officeAccessToken, OfficeAuthError } from '../office/credentials'
import { OfficeHttpError, officeRequest } from '../office/http'
import { calendarFor, quickbooksFor } from '../office/providers'
import { syntheticHubSpot } from '../office/synthetic'
import type { OfficeConnectionRow } from '../office/connections'
import { accessToken, EmailAuthError, type EmailAccountRow } from '../email/accounts'
import { emailAdapter } from '../email/adapters'
import { emailConfig } from '../email/config'
import { stripeRequest, StripeError } from '../billing/stripe'
import { countWorkflow } from '../ai/meter'
import type { IntegrationKey, ProbeResult } from './types'

/** A connection as the hub sees it, whichever table it lives in. */
export type ConnRef = {
  integration: IntegrationKey; id: string; orgId: string; label: string
  /** the connection row's own status, as stored (active, needs_reauth, error, pending ...) */
  rawStatus: string; reason: string | null; synthetic: boolean; external: string; connectedAt: string | null
}

type Detail = ProbeResult['detail']
const ok = (message: string, detail: Detail = {}): Omit<ProbeResult, 'latencyMs'> => ({ ok: true, code: null, message, detail })
const fail = (code: string, message: string, detail: Detail = {}): Omit<ProbeResult, 'latencyMs'> => ({ ok: false, code, message, detail })

/** Tests only: route the Stripe probe through a fake fetch. */
let stripeFetch: typeof fetch | undefined
export function setProbeStripeFetch(f: typeof fetch | null) { stripeFetch = f ?? undefined }

// ---------------------------------------------------------------- commerce

async function shopify(c: ConnRef) {
  const conn = await admin(db => loadConnection(db, c.id))
  if (!conn) return fail('not_found', 'The store connection no longer exists.')
  try {
    const d = await shopifyGraphql<{ shop?: { name?: string } }>(conn, { query: Q_SHOP, operationName: 'DeploiShop' }, { maxAttempts: 2 })
    const t = throttleStatusFor(conn.id)
    return ok(`Shopify answered: read the shop "${(d.shop?.name ?? conn.external_id).slice(0, 80)}"${c.synthetic ? ' (synthetic test store)' : ''}.`,
      t ? { rateLimitAvailable: t.currentlyAvailable, rateLimitMax: t.maximumAvailable, rateLimitRestorePerSecond: t.restoreRate } : {})
  } catch (e) {
    if (e instanceof ShopifyApiError) {
      if (e.kind === 'auth') return fail('auth', 'Shopify did not accept the store\'s access token. Open Deploi from your Shopify admin to renew it.')
      if (e.kind === 'throttled') return fail('rate_limited', 'Shopify asked Deploi to slow down; the next check will try again.')
      if (e.kind === 'network') return fail('network', 'Shopify did not answer.')
      return fail(e.status && e.status >= 500 ? 'server' : 'invalid', `Shopify answered with an error${e.status ? ` (HTTP ${e.status})` : ''}.`)
    }
    throw e
  }
}

async function woocommerce(c: ConnRef) {
  const conn = await admin(db => loadConnection(db, c.id))
  if (!conn) return fail('not_found', 'The store connection no longer exists.')
  try {
    const site = await siteFor(conn)
    const r = await wooRequest<{ environment?: { version?: string } }>(site, { path: '/system_status' }, { maxAttempts: 2 })
    const v = String(r.data?.environment?.version ?? '').slice(0, 20)
    return ok(`The store answered${v ? `: WooCommerce ${v}` : ''}${c.synthetic ? ' (synthetic test store)' : ''}.`, v ? { wcVersion: v } : {})
  } catch (e) {
    if (e instanceof WooApiError) {
      if (e.kind === 'auth') return fail('auth', 'The store refused Deploi\'s API key (deleted, or its permission changed). Reconnect with a new Read/Write key.')
      if (e.kind === 'not_found') return fail('not_found', 'No WooCommerce REST API answered at the store\'s address.')
      if (e.kind === 'rejected') return fail('invalid', 'The store refused the request.')
      return fail(e.status === 429 ? 'rate_limited' : e.status && e.status >= 500 ? 'server' : 'network', e.status ? `The store answered HTTP ${e.status}.` : 'The store did not answer.')
    }
    throw e
  }
}

// ---------------------------------------------------------------- office

function officeFailure(e: unknown, label: string) {
  if (e instanceof OfficeAuthError) return fail('auth', `${label} no longer accepts this connection. Reconnect it.`)
  if (e instanceof OfficeHttpError) {
    if (e.code === 'auth') return fail('auth', `${label} rejected Deploi's authorization. Reconnect it.`)
    if (e.code === 'forbidden') return fail('forbidden', `${label} refused: a permission Deploi needs is missing. Reconnect and approve every permission.`)
    if (e.code === 'rate_limited') return fail('rate_limited', `${label} asked Deploi to slow down; the next check will try again.`)
    if (e.code === 'network') return fail('network', `${label} did not answer.`)
    if (e.code === 'server') return fail('server', `${label} had an error (HTTP ${e.status}).`)
    return fail(e.code, `${label} answered HTTP ${e.status}.`)
  }
  return null
}

async function officeRow(id: string) {
  return admin(db => db.one<OfficeConnectionRow>('select * from office_connections where id = $1', [id]))
}

const header = (h: Headers, k: string) => { const v = Number(h.get(k)); return h.get(k) !== null && Number.isFinite(v) ? v : null }

async function hubspot(c: ConnRef) {
  const row = await officeRow(c.id)
  if (!row || row.status === 'disconnected') return fail('not_found', 'The HubSpot connection no longer exists.')
  try {
    if (row.is_synthetic) {
      await syntheticHubSpot(row.id).searchLeads({ since: new Date(Date.now() - 864e5), after: null, limit: 1 })
      return ok('HubSpot answered a contacts read (synthetic test portal).')
    }
    const token = await officeAccessToken(row.id)
    countWorkflow(row.org_id, 'provider_call', 'hubspot')
    const r = await officeRequest('hubspot', 'https://api.hubapi.com/crm/v3/objects/contacts?limit=1&archived=false', { headers: { authorization: `Bearer ${token}` } })
    return ok('HubSpot answered a contacts read (one record asked for; nothing changed).', {
      rateLimitRemaining: header(r.headers, 'x-hubspot-ratelimit-remaining'), rateLimitMax: header(r.headers, 'x-hubspot-ratelimit-max'),
      dailyRemaining: header(r.headers, 'x-hubspot-ratelimit-daily-remaining'), dailyMax: header(r.headers, 'x-hubspot-ratelimit-daily'),
    })
  } catch (e) { const f = officeFailure(e, 'HubSpot'); if (f) return f; throw e }
}

async function calendar(c: ConnRef) {
  const row = await officeRow(c.id)
  if (!row || row.status === 'disconnected') return fail('not_found', 'The Google Calendar connection no longer exists.')
  try {
    const now = new Date()
    const busy = await calendarFor(row).freeBusy({ timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 3600e3).toISOString(), timeZone: row.timezone ?? 'UTC' })
    return ok(`Google Calendar answered: availability for the next hour (${busy.length} busy block${busy.length === 1 ? '' : 's'})${row.is_synthetic ? ' (synthetic test calendar)' : ''}.`)
  } catch (e) { const f = officeFailure(e, 'Google Calendar'); if (f) return f; throw e }
}

async function quickbooks(c: ConnRef) {
  const row = await officeRow(c.id)
  if (!row || row.status === 'disconnected') return fail('not_found', 'The QuickBooks connection no longer exists.')
  try {
    const info = await quickbooksFor(row).companyInfo()
    return ok(`QuickBooks answered: read the company "${(info.name ?? row.display_name ?? 'company').slice(0, 80)}"${row.is_synthetic ? ' (synthetic test company)' : ''}.`)
  } catch (e) { const f = officeFailure(e, 'QuickBooks'); if (f) return f; throw e }
}

// ---------------------------------------------------------------- email

async function mailbox(c: ConnRef) {
  const acc = await admin(db => db.one<EmailAccountRow>('select * from email_accounts where id = $1', [c.id]))
  if (!acc || acc.status === 'disconnected') return fail('not_found', 'The email account is no longer connected.')
  const label = c.integration === 'gmail' ? 'Google' : 'Microsoft'
  try {
    const token = await accessToken(acc.id)
    countWorkflow(acc.org_id, 'provider_call', c.integration === 'gmail' ? 'gmail' : 'microsoft_graph')
    const who = await emailAdapter(acc.provider).identity(token)
    if (who.address.toLowerCase() !== acc.address.toLowerCase()) return fail('identity_changed', `The connection now signs in as a different account than ${acc.address}. Reconnect the right account.`)
    return ok(`${label} answered: signed in as ${acc.address}.`)
  } catch (e) {
    if (e instanceof EmailAuthError) return fail('auth', `${label} no longer accepts this connection. Reconnect the account.`)
    const m = /\((\d{3})\)/.exec((e as Error).message ?? '')
    if (m && (m[1] === '401' || m[1] === '403')) return fail('auth', `${label} rejected the connection (HTTP ${m[1]}). Reconnect the account.`)
    return fail(m && Number(m[1]) >= 500 ? 'server' : 'network', `${label} did not answer properly.`)
  }
}

async function agentMailbox(c: ConnRef) {
  if (!emailConfig.agentMailDomain || !emailConfig.resendKey) return fail('not_configured', 'Agent mail is not set up on this deployment.')
  const live = emailConfig.liveSends === 'all' ? 'on' : emailConfig.liveSends === 'allowlist' ? 'test recipients only' : 'off (messages are held)'
  return ok(`Agent address ${c.label} is set up on Deploi's mail domain. Live sending: ${live}. No message was sent.`, { liveSending: emailConfig.liveSends })
}

async function stripe(c: ConnRef) {
  try {
    const cus = await stripeRequest<{ id?: string; deleted?: boolean; livemode?: boolean }>('GET', `/v1/customers/${c.external}`, {}, { fetchImpl: stripeFetch })
    if (cus.deleted) return fail('not_found', 'Stripe says your billing account was deleted.')
    return ok('Stripe answered: your billing account exists.', { livemode: Boolean(cus.livemode) })
  } catch (e) {
    if (e instanceof StripeError) {
      if (e.type === 'not_configured') return fail('not_configured', 'Billing is not set up on this deployment.')
      if (e.status === 401) return fail('auth', 'Stripe refused Deploi\'s key.')
      if (e.status === 404) return fail('not_found', 'Stripe has no such billing account.')
      if (e.status === 429) return fail('rate_limited', 'Stripe asked Deploi to slow down.')
      return fail(e.status >= 500 ? 'server' : 'invalid', `Stripe answered HTTP ${e.status}.`)
    }
    return fail('network', 'Stripe did not answer.')
  }
}

const PROBES: Record<IntegrationKey, (c: ConnRef) => Promise<Omit<ProbeResult, 'latencyMs'>>> = {
  shopify, woocommerce, hubspot, google_calendar: calendar, quickbooks, gmail: mailbox, microsoft: mailbox, agent_mailbox: agentMailbox, stripe,
}

export class ProbeTimeout extends Error { constructor() { super('probe timed out'); this.name = 'ProbeTimeout' } }

/** Run one probe with a timeout. Never throws: an unexpected failure is a result with code `error`. */
export async function runProbe(c: ConnRef, timeoutMs = 20_000): Promise<ProbeResult> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const r = await Promise.race([
      PROBES[c.integration](c),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProbeTimeout()), timeoutMs) }),
    ])
    return { ...r, latencyMs: Date.now() - started }
  } catch (e) {
    if (e instanceof ProbeTimeout) return { ok: false, code: 'timeout', message: `No answer within ${Math.round(timeoutMs / 1000)} seconds.`, detail: {}, latencyMs: Date.now() - started }
    return { ok: false, code: 'error', message: 'The check failed unexpectedly; the next check will try again.', detail: {}, latencyMs: Date.now() - started }
  } finally { if (timer) clearTimeout(timer) }
}
