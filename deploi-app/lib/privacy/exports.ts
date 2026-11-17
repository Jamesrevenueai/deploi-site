/**
 * Customer data exports for Shopify `customers/data_request`. The export is stored encrypted (AES-256-GCM
 * with the credentials key, bound to the row id) for the merchant to download from the app (owners and
 * admins only) and answer the customer; Deploi sends it to no one. Each download is recorded.
 */
import { randomUUID } from 'node:crypto'
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { decryptSecret, encryptSecret } from '../connectors/credentials'
import { assertCan } from '../platform/rbac'
import type { CustomerExport } from './customer-data'

const aad = (id: string) => `privacy-export:${id}`

export async function storeExport(db: Db, e: { orgId: string; connectionId: string | null; requestId: string; shop: string; subjectHash: string; data: CustomerExport }): Promise<string> {
  const id = randomUUID()
  const json = JSON.stringify(e.data)
  const enc = encryptSecret(json, aad(id))
  await db.query(`insert into privacy_exports (id, org_id, connection_id, request_id, shop, subject_hash, summary, size_bytes, key_id, content_ciphertext) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, e.orgId, e.connectionId, e.requestId, e.shop, e.subjectHash, JSON.stringify(e.data.counts), Buffer.byteLength(json), enc.keyId, enc.ciphertext])
  return id
}

export type PrivacyExportView = { id: string; shop: string; subjectHash: string; summary: Record<string, number>; sizeBytes: number; createdAt: string; expiresAt: string; downloadedAt: string | null; downloadedBy: string | null; downloads: number }
export type PrivacyRequestView = { id: string; topic: string; status: string; receivedAt: string; completedAt: string | null; subjectHash: string | null; result: Record<string, unknown> }

/** The organization's exports and privacy requests (facts only: hashes and counts, never an address). */
export async function privacyView(actor: Actor): Promise<{ exports: PrivacyExportView[]; requests: PrivacyRequestView[] }> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'customer data exports are for the merchant only')
  assertMerchant(actor, actor.orgId)
  await assertCan(actor, actor.orgId, 'settings')
  const exports = await withActor(actor, db => db.query<{ id: string; shop: string; subject_hash: string; summary: Record<string, number>; size_bytes: number; created_at: string; expires_at: string; downloaded_at: string | null; downloaded_by: string | null; download_count: number }>(
    `select id, shop, subject_hash, summary, size_bytes, created_at, expires_at, downloaded_at, downloaded_by, download_count from privacy_exports where org_id = $1 and expires_at > now() order by created_at desc limit 100`, [actor.orgId]))
  // compliance requests are staff-readable only under RLS: read for the merchant's own organization server-side
  const requests = await admin(db => db.query<{ id: string; topic: string; status: string; received_at: string; completed_at: string | null; subject_hash: string | null; result: Record<string, unknown> }>(
    `select id, topic, status, received_at, completed_at, subject_hash, result from shopify_compliance_requests where org_id = $1 and topic <> 'shop/redact' order by received_at desc limit 100`, [actor.orgId]))
  return {
    exports: exports.map(x => ({ id: x.id, shop: x.shop, subjectHash: x.subject_hash, summary: x.summary, sizeBytes: x.size_bytes, createdAt: new Date(x.created_at).toISOString(), expiresAt: new Date(x.expires_at).toISOString(), downloadedAt: x.downloaded_at ? new Date(x.downloaded_at).toISOString() : null, downloadedBy: x.downloaded_by, downloads: x.download_count })),
    requests: requests.map(r => ({ id: r.id, topic: r.topic, status: r.status, receivedAt: new Date(r.received_at).toISOString(), completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null, subjectHash: r.subject_hash, result: r.result })),
  }
}

/** Decrypt one export for an owner or admin of its organization; the download is recorded. */
export async function downloadExport(actor: Actor, id: string): Promise<{ filename: string; json: string }> {
  if (actor.kind === 'staff') throw new EngineError('forbidden', 'customer data exports are for the merchant only')
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new EngineError('not_found', 'export not found')
  const visible = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from privacy_exports where id = $1 and org_id = $2 and expires_at > now()', [id, actor.orgId]))
  if (!visible) throw new EngineError('not_found', 'export not found')
  assertMerchant(actor, visible.org_id)
  await assertCan(actor, visible.org_id, 'settings')
  return admin(async db => {
    const row = await db.one<{ key_id: string; content_ciphertext: string; created_at: string; subject_hash: string }>('select key_id, content_ciphertext, created_at, subject_hash from privacy_exports where id = $1 for update', [id])
    if (!row) throw new EngineError('not_found', 'export not found')
    const json = decryptSecret(row.key_id, row.content_ciphertext, aad(id))
    await db.query(`update privacy_exports set downloaded_at = now(), downloaded_by = $2, download_count = download_count + 1 where id = $1`, [id, actor.label.slice(0, 160)])
    await audit(db, { orgId: visible.org_id, entityType: 'org', entityId: id, event: 'privacy.export_downloaded', actor: actor.label, detail: { subject_hash: row.subject_hash } })
    return { filename: `customer-data-${new Date(row.created_at).toISOString().slice(0, 10)}-${row.subject_hash.slice(0, 8)}.json`, json }
  })
}

/** Exports past their keeping time are deleted (called by the retention sweep or the privacy page). */
export async function purgeExpiredExports(db: Db): Promise<number> {
  return (await db.query(`delete from privacy_exports where expires_at <= now() returning id`)).length
}
