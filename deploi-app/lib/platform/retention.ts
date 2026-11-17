/**
 * Data retention (docs/DATA-RETENTION.md). Daily job platform.retention (lib/platform/jobs.ts), safe to run
 * any number of times: each step only touches rows past their retention period.
 *
 *   emailBodies      outbound email content (email_messages) that is finished (accepted, failed, cancelled,
 *                    unknown) and older than RETENTION_EMAIL_BODIES_DAYS (365): the encrypted content is
 *                    erased; the message record (who, when, status, hash) stays
 *   inboundRaw       inbound email content, authentication results and attachment metadata (email_inbound)
 *                    older than RETENTION_INBOUND_RAW_DAYS (30) are erased; provider delivery log rows
 *                    (inbound_webhook_events) are deleted
 *   jobs             finished job rows older than RETENTION_JOBS_DAYS (90) are deleted
 *   rateLimits       rate-limit windows that expired more than RETENTION_RATE_LIMIT_DAYS (1) ago are deleted
 *   webhookReceipts  webhook receipts older than RETENTION_WEBHOOK_RECEIPTS_DAYS (90) are deleted
 *   agent chat       the rules-only chat with the agents (agent_chat_messages) older than APP_CHAT_RETENTION_DAYS (180)
 *                    is deleted
 *   case history     kept while the organization exists
 * An organization may shorten (or, up to RETENTION_MAX_DAYS = 730, lengthen) its own emailBodies,
 * inboundRaw and jobs periods (agencies.retention, set by an owner or admin). Every period is at least 1 day.
 */
import { admin, type Db } from '../db'
import { recordHeartbeat } from '../jobs/heartbeat'
import { EngineError } from '../engine/errors'
import { audit } from '../engine/audit'
import type { Actor } from '../engine/actor'
import { assertCan } from './rbac'

export const RETENTION_KEYS = ['emailBodies', 'inboundRaw', 'jobs', 'rateLimits', 'webhookReceipts'] as const
export type RetentionKey = typeof RETENTION_KEYS[number]
export const ORG_ADJUSTABLE: readonly RetentionKey[] = ['emailBodies', 'inboundRaw', 'jobs']
const ENV: Record<RetentionKey, [string, number]> = {
  emailBodies: ['RETENTION_EMAIL_BODIES_DAYS', 365], inboundRaw: ['RETENTION_INBOUND_RAW_DAYS', 30], jobs: ['RETENTION_JOBS_DAYS', 90],
  rateLimits: ['RETENTION_RATE_LIMIT_DAYS', 1], webhookReceipts: ['RETENTION_WEBHOOK_RECEIPTS_DAYS', 90],
}
export const RETENTION_MAX_DAYS = 730

export function retentionDefaults(e: Record<string, string | undefined> = process.env): Record<RetentionKey, number> {
  const out = {} as Record<RetentionKey, number>
  for (const k of RETENTION_KEYS) { const [name, d] = ENV[k]; const n = Number((e[name] ?? '').trim()); out[k] = Number.isInteger(n) && n >= 1 && n <= RETENTION_MAX_DAYS ? n : d }
  return out
}

export type RetentionResult = { emailBodiesErased: number; inboundErased: number; inboundEventsDeleted: number; jobsDeleted: number; rateLimitsDeleted: number; webhookReceiptsDeleted: number; privacyExportsDeleted: number; agentChatDeleted: number }

/** Days the agent chat is kept (APP_CHAT_RETENTION_DAYS, 1 to 730; default 180). */
export function chatRetentionDays(e: Record<string, string | undefined> = process.env): number {
  const n = Number((e.APP_CHAT_RETENTION_DAYS ?? '').trim())
  return Number.isInteger(n) && n >= 1 && n <= RETENTION_MAX_DAYS ? n : 180
}

const days = (k: RetentionKey) => `make_interval(days => coalesce(case when (g.retention->>'${k}') ~ '^[0-9]{1,4}$' then least(greatest((g.retention->>'${k}')::int, 1), ${RETENTION_MAX_DAYS}) end, $2::int))`

/** One pass over every retention rule. Returns what was erased or deleted (counts only). */
export async function runRetention(opts: { now?: Date } = {}): Promise<RetentionResult> {
  const now = (opts.now ?? new Date()).toISOString()
  const d = retentionDefaults()
  const r = await admin(async db => {
    const n = async (sql: string, params: unknown[]) => (await db.raw.query(sql, params)).rowCount ?? 0
    return {
      emailBodiesErased: await n(`update email_messages m set content_ciphertext = '', body_purged_at = $1::timestamptz from agencies g
        where g.id = m.org_id and m.body_purged_at is null and m.status in ('accepted','failed','cancelled','delivery_unknown') and m.created_at < $1::timestamptz - ${days('emailBodies')}`, [now, d.emailBodies]),
      inboundErased: await n(`update email_inbound i set content_ciphertext = '', auth_results = '{}'::jsonb, attachments = '[]'::jsonb, body_purged_at = $1::timestamptz from agencies g
        where g.id = i.org_id and i.body_purged_at is null and i.received_at < $1::timestamptz - ${days('inboundRaw')}`, [now, d.inboundRaw]),
      inboundEventsDeleted: await n(`delete from inbound_webhook_events where received_at < $1::timestamptz - make_interval(days => $2::int)`, [now, d.inboundRaw]),
      jobsDeleted: await n(`delete from jobs j using (select j2.id from jobs j2 left join agencies g on g.id = j2.org_id
          where j2.status in ('succeeded','failed','dead','cancelled') and coalesce(j2.finished_at, j2.updated_at) < $1::timestamptz - ${days('jobs')} limit 20000) old where j.id = old.id`, [now, d.jobs]),
      rateLimitsDeleted: await n(`delete from rate_limits where expires_at < $1::timestamptz - make_interval(days => $2::int)`, [now, d.rateLimits]),
      webhookReceiptsDeleted: await n(`delete from webhook_receipts where received_at < $1::timestamptz - make_interval(days => $2::int)`, [now, d.webhookReceipts]),
      // a customer's data export (Shopify customers/data_request) is kept only until its expiry
      privacyExportsDeleted: await n(`delete from privacy_exports where expires_at <= $1::timestamptz`, [now]),
      agentChatDeleted: await n(`delete from agent_chat_messages where created_at < $1::timestamptz - make_interval(days => $2::int)`, [now, chatRetentionDays()]),
    }
  })
  await recordHeartbeat('platform.retention', 'ok', r).catch(() => {})
  return r
}

/** The organization's retention periods: the defaults with its own adjustments. Any member may read it. */
export async function retentionFor(actor: Actor) {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'retention settings belong to an organization')
  const org = await admin(db => db.one<{ retention: Record<string, unknown> }>('select retention from agencies where id = $1', [actor.orgId]))
  return describe(org?.retention ?? {})
}

function describe(own: Record<string, unknown>) {
  const d = retentionDefaults()
  const periods = RETENTION_KEYS.map(k => {
    const o = ORG_ADJUSTABLE.includes(k) && typeof own[k] === 'number' ? Math.min(Math.max(own[k] as number, 1), RETENTION_MAX_DAYS) : null
    return { key: k, days: o ?? d[k], defaultDays: d[k], adjusted: o !== null, adjustable: ORG_ADJUSTABLE.includes(k) }
  })
  return { periods, caseHistory: 'kept while the organization exists', maxDays: RETENTION_MAX_DAYS }
}

/** Owner or admin: adjust emailBodies, inboundRaw or jobs (null restores the default). */
export async function setRetention(actor: Actor, patch: Record<string, unknown>) {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'retention settings belong to an organization')
  await assertCan(actor, actor.orgId, 'settings')
  const clean: Record<string, number | null> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (!(ORG_ADJUSTABLE as readonly string[]).includes(k)) throw new EngineError('invalid_input', `${k} cannot be adjusted (adjustable: ${ORG_ADJUSTABLE.join(', ')})`)
    if (v !== null && !(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= RETENTION_MAX_DAYS)) throw new EngineError('invalid_input', `${k} must be 1 to ${RETENTION_MAX_DAYS} days, or null for the default`)
    clean[k] = v as number | null
  }
  return admin(async (db: Db) => {
    const cur = (await db.one<{ retention: Record<string, unknown> }>('select retention from agencies where id = $1 for update', [actor.orgId]))?.retention ?? {}
    const next: Record<string, unknown> = { ...cur }
    for (const [k, v] of Object.entries(clean)) { if (v === null) delete next[k]; else next[k] = v }
    await db.query('update agencies set retention = $2 where id = $1', [actor.orgId, JSON.stringify(next)])
    await audit(db, { orgId: actor.orgId, entityType: 'org', entityId: actor.orgId, event: 'org.retention_changed', actor: actor.label, detail: { from: cur, to: next } })
    return describe(next)
  })
}
