/**
 * Shopify's mandatory privacy webhooks. Each delivery is recorded once (shopify_compliance_requests,
 * keyed by the webhook id) without keeping the customer's contact details: the customer is stored as a
 * one-way hash. What the app holds about a customer is limited by its scopes (no customer or order
 * scopes): the only place a customer's address can appear is an agent mailbox, when a customer writes to
 * an agent's address or an agent's message was addressed to them. So:
 *  - customers/data_request: counts what is held for that address and tells the merchant (audit event
 *    shown in the work log) so they can answer the customer; nothing is sent anywhere by the app.
 *  - customers/redact: deletes that mail (received from, or sent to, the address) for the shop's organization.
 *  - shop/redact (48 hours after uninstall): erases the shop (install.ts#redactShop), unless it reinstalled.
 */
import { createHash } from 'node:crypto'
import type { Db } from '../../db'
import { audit } from '../../engine/audit'
import { redactShop } from './install'

export type ComplianceTopic = 'customers/data_request' | 'customers/redact' | 'shop/redact'
type Payload = { customer?: { id?: number | string; email?: string | null; phone?: string | null } | null; orders_requested?: unknown[]; orders_to_redact?: unknown[] }

const bare = (a: string) => a.trim().toLowerCase()
export const subjectHash = (shop: string, email: string | null, customerId: string | null) =>
  createHash('sha256').update(`${shop}|${email ? bare(email) : ''}|${customerId ?? ''}`).digest('hex')

export type ComplianceResult = { status: 'completed' | 'deferred'; result: Record<string, unknown>; duplicate?: boolean }

export async function handleCompliance(db: Db, input: { topic: ComplianceTopic; shop: string; webhookId: string; payload: Record<string, unknown>; conn: { id: string; org_id: string } | null; actor: string }): Promise<ComplianceResult> {
  const p = input.payload as Payload
  const email = typeof p.customer?.email === 'string' && p.customer.email.includes('@') ? bare(p.customer.email) : null
  const customerId = p.customer?.id !== undefined && p.customer?.id !== null ? String(p.customer.id) : null
  const hash = input.topic === 'shop/redact' ? null : subjectHash(input.shop, email, customerId)
  const row = await db.one<{ id: string }>(`insert into shopify_compliance_requests (shop, connection_id, org_id, topic, webhook_id, subject_hash) values ($1,$2,$3,$4,$5,$6)
    on conflict (webhook_id) do nothing returning id`, [input.shop, input.conn?.id ?? null, input.conn?.org_id ?? null, input.topic, input.webhookId, hash])
  if (!row) return { status: 'completed', result: {}, duplicate: true }

  let status: ComplianceResult['status'] = 'completed'
  let result: Record<string, unknown>
  if (input.topic === 'shop/redact') {
    const r = await redactShop(db, input.shop)
    if (r.skipped) status = 'deferred'
    result = { shop_data_erased: r.deleted, organization_erased: r.orgDeleted, ...(r.skipped ? { skipped: r.skipped } : {}) }
  } else if (!input.conn || !email) {
    // no store connection (never installed, or already erased), or no address to look for: nothing is held
    result = { customer_data_held: false, reason: !input.conn ? 'no data held for this shop' : 'the request names no email address; the app holds no data keyed by customer id' }
  } else if (input.topic === 'customers/data_request') {
    const inbound = await db.one<{ n: string }>('select count(*)::text as n from email_inbound where org_id = $1 and from_address = $2', [input.conn.org_id, email])
    const sent = await db.one<{ n: string }>('select count(*)::text as n from email_messages where org_id = $1 and ($2 = any(to_addresses) or $2 = any(cc_addresses))', [input.conn.org_id, email])
    const held = { inbound_messages: Number(inbound?.n ?? 0), sent_messages: Number(sent?.n ?? 0) }
    result = { customer_data_held: held.inbound_messages + held.sent_messages > 0, ...held }
  } else {
    const inbound = await db.query('delete from email_inbound where org_id = $1 and from_address = $2 returning id', [input.conn.org_id, email])
    // a message is erased whole when the customer is on it; supplier requests that pointed at it lose the link only
    const sent = await db.query('delete from email_messages where org_id = $1 and ($2 = any(to_addresses) or $2 = any(cc_addresses)) returning id', [input.conn.org_id, email])
    result = { inbound_deleted: inbound.length, sent_deleted: sent.length }
  }
  await db.query(`update shopify_compliance_requests set status = $2, result = $3, completed_at = case when $2 = 'completed' then now() else null end where id = $1`, [row.id, status, JSON.stringify(result)])
  // the merchant sees data requests in the work log (counts only, never the address)
  const orgExists = input.conn ? await db.one('select 1 from agencies where id = $1', [input.conn.org_id]) : null
  if (input.conn && orgExists) await audit(db, { orgId: input.conn.org_id, connectionId: input.topic === 'shop/redact' && result.shop_data_erased ? undefined : input.conn.id, entityType: 'webhook', entityId: row.id, event: `compliance.${input.topic.replace('/', '.')}`, actor: input.actor, detail: result })
  return { status, result }
}
