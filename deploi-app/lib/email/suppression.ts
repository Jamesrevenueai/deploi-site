/**
 * Suppressed recipients, per organization: an address that bounced, marked a message as spam or
 * unsubscribed is never sent to again by that organization's agents or people (checked right before
 * every send in lib/email/engine.ts#sendMessage). Suppression is per organization so one tenant's
 * recipients are never revealed to, or blocked for, another.
 */
import type { Db } from '../db'
import { audit } from '../engine/audit'
import { addressHash } from '../privacy/customer-data'

export type SuppressionReason = 'bounced' | 'complained' | 'unsubscribed' | 'manual'

export async function suppressAddresses(db: Db, s: { orgId: string; addresses: string[]; reason: SuppressionReason; sourceMessageId?: string | null; detail?: string | null; actor: string }): Promise<string[]> {
  const addrs = [...new Set(s.addresses.map(a => a.trim().toLowerCase()).filter(a => a.length >= 3 && a.length <= 254 && a.includes('@')))]
  const added: string[] = []
  for (const a of addrs) {
    const r = await db.one<{ address: string }>(`insert into email_suppressions (org_id, address, reason, source_message_id, detail, created_by) values ($1,$2,$3,$4,$5,$6)
      on conflict (org_id, address) do nothing returning address`, [s.orgId, a, s.reason, s.sourceMessageId ?? null, s.detail?.slice(0, 300) ?? null, s.actor.slice(0, 160)])
    if (r) added.push(r.address)
  }
  if (added.length) await audit(db, { orgId: s.orgId, entityType: 'email', entityId: s.sourceMessageId ?? null, event: 'email.suppressed', actor: s.actor, detail: { reason: s.reason, count: added.length, email_message: Boolean(s.sourceMessageId) } })
  return added
}

/** Which of these addresses this organization may no longer send to. */
export async function suppressedAmong(db: Db, orgId: string, addresses: string[]): Promise<string[]> {
  if (!addresses.length) return []
  const plain = addresses.map(a => a.toLowerCase())
  // an address erased at a customer's request is kept only as a one-way hash, so its opt-out still holds (lib/privacy/customer-data.ts)
  const hashed = new Map(plain.map(a => [`sha256:${addressHash(orgId, a)}`, a]))
  const rows = await db.query<{ address: string }>('select address from email_suppressions where org_id = $1 and address = any($2::text[])', [orgId, [...plain, ...hashed.keys()]])
  return [...new Set(rows.map(r => hashed.get(r.address) ?? r.address))]
}
