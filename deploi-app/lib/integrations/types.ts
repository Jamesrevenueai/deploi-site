/**
 * The integration hub's shared shapes (safe to import from client components: no server code here).
 *
 * Status of an integration for one organization:
 *   connected       a working connection (the last probe, if any, succeeded or failed fewer than three times)
 *   needs_reauth    the provider no longer accepts the authorization (refused refresh, 401, missing permission):
 *                   the customer reconnects it; the connection keeps its id, so agents and cases keep working
 *   error           repeated failures that a reconnection may not fix (the provider is down, the store unreachable)
 *   not_connected   available here, nothing connected yet
 *   not_configured  this deployment lacks the settings it needs (staff see which; customers see "Not available yet")
 */
export const INTEGRATION_KEYS = ['shopify', 'woocommerce', 'hubspot', 'google_calendar', 'quickbooks', 'agent_mailbox', 'gmail', 'microsoft', 'stripe'] as const
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number]
export type HealthStatus = 'connected' | 'needs_reauth' | 'error' | 'not_connected' | 'not_configured'
export type Suite = 'commerce' | 'office' | 'email' | 'billing'
export type AuthKind = 'app_install' | 'api_key' | 'oauth2' | 'oauth2_pkce' | 'platform_key'
export type WebhookSupport = 'reregister' | 'readonly' | 'portal' | 'none'

export const isIntegrationKey = (v: unknown): v is IntegrationKey => typeof v === 'string' && (INTEGRATION_KEYS as readonly string[]).includes(v)

export type ScopeExplained = { scope: string; why: string }

export type ConnectionView = {
  id: string; label: string; status: HealthStatus; reason: string | null; synthetic: boolean
  lastCheckedAt: string | null; lastSuccessAt: string | null; nextCheckAt: string | null; consecutiveFailures: number
  lastError: { code: string | null; message: string; at: string | null } | null
}

export type IntegrationView = {
  key: IntegrationKey; name: string; suite: Suite; authKind: AuthKind
  usedFor: string; permissions: string[]; scopes: ScopeExplained[]; docs: string; liveVerified: boolean
  status: HealthStatus; detail: string
  lastCheckedAt: string | null; lastSuccessAt: string | null
  lastError: { code: string | null; message: string; at: string | null } | null
  connections: ConnectionView[]
  can: { connect: boolean; reconnect: boolean; disconnect: boolean; test: boolean; webhooks: WebhookSupport; synthetic: boolean }
  /** where the customer connects it (the existing flow) */
  connectHref: string
  /** staff only: the environment variables this deployment is missing (never sent to a customer) */
  missingEnv?: string[]
}

export type ProbeResult = {
  ok: boolean
  /** auth, forbidden, timeout, network, server, rate_limited, not_found, invalid, identity_changed, not_configured */
  code: string | null
  message: string
  latencyMs: number
  /** rate-limit headroom, token expiry and similar; never secrets */
  detail: Record<string, string | number | boolean | null>
}

export type TestOutcome = { connectionId: string; label: string; ok: boolean; previous: HealthStatus; status: HealthStatus; message: string; code: string | null; latencyMs: number }

export const STATUS_WORDS: Record<HealthStatus, { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' }> = {
  connected: { label: 'Connected', tone: 'ok' },
  needs_reauth: { label: 'Needs reconnecting', tone: 'warn' },
  error: { label: 'Not working', tone: 'danger' },
  not_connected: { label: 'Not connected', tone: 'muted' },
  not_configured: { label: 'Not available yet', tone: 'muted' },
}
