/**
 * Diagnostics for the "Advanced" drawer (one organization) and the staff cross-organization view.
 * Per connection: the recent checks, error codes of the last seven days, API calls this month (the workflow
 * cost counters), the rate-limit headroom the provider last reported, webhook registration state and token
 * expiry. Never a token, a key, a secret or a record's content.
 */
import { admin, type Db } from '../db'
import { monthOf } from '../ai/meter'
import { INTEGRATIONS, integrationDef, missingEnv, scrubEnvNames, statusOf } from './registry'
import { webhookState, type WebhookState } from './webhooks'
import type { HealthStatus, IntegrationKey, IntegrationView } from './types'

/** workflow_costs connector name per integration (lib/ai/meter.ts) */
export const METER_CONNECTOR: Partial<Record<IntegrationKey, string>> = {
  shopify: 'shopify', woocommerce: 'woocommerce', hubspot: 'hubspot', google_calendar: 'google_calendar', quickbooks: 'quickbooks', gmail: 'gmail', microsoft: 'microsoft_graph',
  salesforce: 'salesforce', pipedrive: 'pipedrive', zoho_crm: 'zoho_crm', buildium: 'buildium',
}

export type CheckRow = { at: string; trigger: string; ok: boolean; previous: HealthStatus | null; status: HealthStatus; code: string | null; message: string; latencyMs: number | null }
export type ConnectionDiagnostics = {
  connectionId: string; label: string; synthetic: boolean
  recentChecks: CheckRow[]
  errorCodes: { code: string; count: number }[]
  rateLimit: Record<string, string | number | boolean | null> | null
  token: { kind: string | null; expiresAt: string | null; refreshExpiresAt: string | null; stored: boolean } | null
  webhooks: WebhookState | null
}
export type Diagnostics = { key: IntegrationKey; callsThisMonth: number | null; connections: ConnectionDiagnostics[] }

async function tokenInfo(db: Db, key: IntegrationKey, id: string): Promise<ConnectionDiagnostics['token']> {
  if (key === 'shopify' || key === 'woocommerce') {
    const r = await db.one<{ token_kind: string; expires_at: string | null; refresh_expires_at: string | null }>('select token_kind, expires_at::text, refresh_expires_at::text from store_credentials where connection_id = $1', [id])
    return { kind: r?.token_kind ?? null, expiresAt: r?.expires_at ?? null, refreshExpiresAt: r?.refresh_expires_at ?? null, stored: Boolean(r) }
  }
  if (key === 'hubspot' || key === 'google_calendar' || key === 'quickbooks' || key === 'salesforce' || key === 'pipedrive' || key === 'zoho_crm' || key === 'buildium') {
    const r = await db.one<{ expires_at: string | null; has_refresh: boolean }>('select expires_at::text, refresh_ciphertext is not null as has_refresh from office_credentials where connection_id = $1', [id])
    return { kind: r ? (key === 'buildium' ? 'api key' : r.has_refresh ? 'oauth (refreshable)' : 'oauth') : null, expiresAt: r?.expires_at ?? null, refreshExpiresAt: null, stored: Boolean(r) }
  }
  if (key === 'gmail' || key === 'microsoft') {
    const r = await db.one<{ expires_at: string | null; has_refresh: boolean }>('select expires_at::text, refresh_ciphertext is not null as has_refresh from email_credentials where account_id = $1', [id])
    return { kind: r ? (r.has_refresh ? 'oauth (refreshable)' : 'oauth') : null, expiresAt: r?.expires_at ?? null, refreshExpiresAt: null, stored: Boolean(r) }
  }
  return null
}

/** One integration's diagnostics for the organization. `customer`: messages pass through scrubEnvNames. */
export async function diagnostics(orgId: string, key: IntegrationKey, opts: { live?: boolean; staff?: boolean; now?: Date } = {}): Promise<Diagnostics> {
  const def = integrationDef(key)
  const scrub = (s: string) => (opts.staff ? s : scrubEnvNames(s))
  const { conns, calls } = await admin(async db => ({
    conns: await def.connections(db, orgId),
    calls: METER_CONNECTOR[key] ? Number((await db.one<{ n: string }>(`select coalesce(sum(count), 0)::text as n from workflow_costs where org_id = $1 and metric = 'provider_call' and connector = $2 and month = $3::date`, [orgId, METER_CONNECTOR[key], monthOf(opts.now ?? new Date())]))?.n ?? 0) : null,
  }))
  const out: ConnectionDiagnostics[] = []
  for (const c of conns) {
    const rows = await admin(db => db.query<{ checked_at: string; trigger: string; ok: boolean; previous_status: HealthStatus | null; status: HealthStatus; code: string | null; message: string; latency_ms: number | null; detail: Record<string, string | number | boolean | null> }>(
      `select checked_at::text, trigger, ok, previous_status, status, code, message, latency_ms, detail from connection_health where org_id = $1 and integration = $2 and connection_id = $3 order by checked_at desc limit 10`, [orgId, key, c.id]))
    const codes = await admin(db => db.query<{ code: string; n: number }>(
      `select code, count(*)::int as n from connection_health where org_id = $1 and integration = $2 and connection_id = $3 and not ok and code is not null and checked_at > now() - interval '7 days' group by code order by n desc`, [orgId, key, c.id]))
    const withLimit = rows.find(r => Object.keys(r.detail ?? {}).some(k => k.startsWith('rateLimit') || k.startsWith('daily')))
    out.push({
      connectionId: c.id, label: c.label, synthetic: c.synthetic,
      recentChecks: rows.map(r => ({ at: r.checked_at, trigger: r.trigger, ok: r.ok, previous: r.previous_status, status: r.status, code: r.code, message: scrub(r.message), latencyMs: r.latency_ms })),
      errorCodes: codes.map(x => ({ code: x.code, count: x.n })),
      rateLimit: withLimit ? Object.fromEntries(Object.entries(withLimit.detail).filter(([k]) => k.startsWith('rateLimit') || k.startsWith('daily'))) : null,
      token: await admin(db => tokenInfo(db, key, c.id)),
      webhooks: await webhookState(key, c.id, { live: opts.live, staff: opts.staff }),
    })
  }
  return { key, callsThisMonth: calls, connections: out }
}

export type StaffRow = {
  orgId: string; orgName: string; key: IntegrationKey; name: string; status: HealthStatus
  connections: { id: string; label: string; status: HealthStatus; synthetic: boolean; failures: number; lastCheckedAt: string | null; lastSuccessAt: string | null; lastError: string | null; nextCheckAt: string | null }[]
}

/** Staff: every organization's connections with their health, and what this deployment is missing. */
export async function staffOverview(opts: { status?: HealthStatus | null } = {}): Promise<{ setup: { key: IntegrationKey; name: string; missingEnv: string[] }[]; rows: StaffRow[]; transitions: { at: string; orgName: string; key: IntegrationKey; label: string | null; previous: HealthStatus | null; status: HealthStatus; message: string }[] }> {
  return admin(async db => {
    const orgs = await db.query<{ id: string; name: string }>(`select id, name from agencies where org_type = 'merchant' and deleted_at is null order by name`)
    const rows: StaffRow[] = []
    const withConns = new Set<string>()
    for (const d of INTEGRATIONS) for (const c of await d.connections(db, null)) withConns.add(c.orgId)
    for (const o of orgs.filter(x => withConns.has(x.id))) {
      for (const d of INTEGRATIONS) {
        const v: IntegrationView = await statusOf(db, d, o.id)
        if (!v.connections.length) continue
        if (opts.status && v.status !== opts.status) continue
        rows.push({ orgId: o.id, orgName: o.name, key: d.key, name: d.name, status: v.status,
          connections: v.connections.map(c => ({ id: c.id, label: c.label, status: c.status, synthetic: c.synthetic, failures: c.consecutiveFailures, lastCheckedAt: c.lastCheckedAt, lastSuccessAt: c.lastSuccessAt, lastError: c.lastError?.message ?? c.reason, nextCheckAt: c.nextCheckAt })) })
      }
    }
    const t = await db.query<{ checked_at: string; org_name: string; integration: IntegrationKey; previous_status: HealthStatus | null; status: HealthStatus; message: string; connection_id: string }>(
      `select h.checked_at::text, g.name as org_name, h.integration, h.previous_status, h.status, h.message, h.connection_id from connection_health h join agencies g on g.id = h.org_id
       where h.previous_status is distinct from h.status order by h.checked_at desc limit 50`)
    const labels = new Map(rows.flatMap(r => r.connections.map(c => [c.id, c.label] as const)))
    return {
      setup: INTEGRATIONS.map(d => ({ key: d.key, name: d.name, missingEnv: missingEnv(d) })),
      rows,
      transitions: t.map(x => ({ at: x.checked_at, orgName: x.org_name, key: x.integration, label: labels.get(x.connection_id) ?? null, previous: x.previous_status, status: x.status, message: x.message })),
    }
  })
}
