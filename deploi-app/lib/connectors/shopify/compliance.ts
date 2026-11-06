/**
 * Shopify's mandatory privacy webhooks. Each delivery is recorded once (shopify_compliance_requests, keyed by
 * the webhook id) without keeping the customer's contact details: the customer is stored as a one-way hash.
 * The app reads no Shopify customers or orders, but a shopper can still appear in what Deploi holds: agent
 * mail to and from their address, agent library drafts, Resolution Engine cases and their history, Office
 * leads, meetings and invoices with the same address (lib/privacy/customer-data.ts lists every table). So:
 *  - customers/data_request: builds a JSON export of everything held for that customer (matched on the
 *    email and the Shopify customer and order ids, within the shop's organization only), stores it
 *    encrypted for the merchant to download (/store/privacy), and records that the request was fulfilled.
 *    Nothing is sent anywhere by the app.
 *  - customers/redact: deletes the customer's mail and anonymizes the rest (opt-outs kept as a hash, the
 *    accounting copies keep their amounts, case history keeps its shape); records what was done, per table.
 *    Idempotent: the same delivery is answered once, and a repeat request finds nothing more to change.
 *  - shop/redact (48 hours after uninstall): erases the shop (install.ts#redactShop), unless it reinstalled.
 */
import { createHash } from 'node:crypto'
import type { Db } from '../../db'
import { audit } from '../../engine/audit'
import { redactShop } from './install'
import { collectCustomerData, redactCustomerData, type Subject } from '../../privacy/customer-data'
import { storeExport, purgeExpiredExports } from '../../privacy/exports'

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
  } else if (!input.conn || (!email && !customerId)) {
    // no store connection (never installed, or already erased), or nothing to look for: nothing is held
    result = { customer_data_held: false, reason: !input.conn ? 'no data held for this shop' : 'the request names no email address or customer id' }
  } else {
    const ids = (v: unknown) => (Array.isArray(v) ? v : []).map(x => String(typeof x === 'object' && x && 'id' in x ? (x as { id: unknown }).id : x)).filter(x => /^\d{1,20}$/.test(x)).slice(0, 500)
    const subject: Subject = { orgId: input.conn.org_id, email, customerId, orderIds: ids(input.topic === 'customers/data_request' ? p.orders_requested : p.orders_to_redact) }
    if (input.topic === 'customers/data_request') {
      await purgeExpiredExports(db)
      const data = await collectCustomerData(db, subject, input.shop)
      const exportId = await storeExport(db, { orgId: input.conn.org_id, connectionId: input.conn.id, requestId: row.id, shop: input.shop, subjectHash: hash!, data })
      const held = Object.values(data.counts).reduce((a, b) => a + b, 0)
      result = { customer_data_held: held > 0, export_id: exportId, tables: data.counts, inbound_messages: data.counts.email_inbound ?? 0, sent_messages: data.counts.email_messages ?? 0,
        fulfilled: 'export ready for the merchant to download in the app (Privacy requests)' }
    } else {
      const done = await redactCustomerData(db, subject)
      // exports already built for this customer hold the same data: erased with it
      const exports = await db.query(`delete from privacy_exports where org_id = $1 and subject_hash = $2 returning id`, [input.conn.org_id, hash])
      result = { tables: { ...done, privacy_exports: exports.length }, inbound_deleted: done.email_inbound ?? 0, sent_deleted: done.email_messages ?? 0,
        retained: done.engine_audit_retained ? 'audit entries naming the customer kept unchanged for audit' : 'nothing' }
    }
  }
  await db.query(`update shopify_compliance_requests set status = $2, result = $3, completed_at = case when $2 = 'completed' then now() else null end where id = $1`, [row.id, status, JSON.stringify(result)])
  // the merchant sees data requests in the work log (counts only, never the address)
  const orgExists = input.conn ? await db.one('select 1 from agencies where id = $1', [input.conn.org_id]) : null
  if (input.conn && orgExists) await audit(db, { orgId: input.conn.org_id, connectionId: input.topic === 'shop/redact' && result.shop_data_erased ? undefined : input.conn.id, entityType: 'webhook', entityId: row.id, event: `compliance.${input.topic.replace('/', '.')}`, actor: input.actor, detail: result })
  return { status, result }
}
