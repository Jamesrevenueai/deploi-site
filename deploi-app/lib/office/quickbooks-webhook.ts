/**
 * QuickBooks Online webhooks (optional). Intuit signs each delivery: header `intuit-signature` is the
 * base64 HMAC-SHA256 of the raw body keyed with the app's webhook verifier token. A verified delivery only
 * says WHICH entities changed (company realmId, entity name, id); its content is never trusted as a value.
 * For an Invoice or Payment change the matching open cases are made due now, and their checker reads the
 * invoice from QuickBooks again (the read, not the webhook, is the evidence). Both payload formats Intuit
 * documents are accepted: the classic `eventNotifications` envelope and the CloudEvents array.
 * Not live-verified: see docs/QUICKBOOKS-SETUP.md.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { admin } from '../db'
import { enqueue } from '../jobs/queue'
import { officeConfig } from './config'
import { isRealmId } from './quickbooks'
import '../cases/jobs'

export function intuitSignature(rawBody: string, verifier: string) { return createHmac('sha256', verifier).update(rawBody, 'utf8').digest('base64') }

export function verifyIntuitSignature(rawBody: string, signature: string | null, verifier: string): boolean {
  if (!signature || !verifier) return false
  const want = Buffer.from(intuitSignature(rawBody, verifier)), got = Buffer.from(signature.trim())
  return want.length === got.length && timingSafeEqual(want, got)
}

type Change = { realmId: string; entity: 'invoice' | 'payment'; id: string }

/** The changed entities in a delivery (Invoice and Payment only; anything malformed is dropped). */
export function parseQuickBooksChanges(body: unknown): Change[] {
  const out: Change[] = []
  const add = (realmId: unknown, entity: unknown, id: unknown) => {
    const e = String(entity ?? '').toLowerCase()
    if (isRealmId(realmId) && (e === 'invoice' || e === 'payment') && typeof id === 'string' && /^\d{1,20}$/.test(id) && out.length < 200) out.push({ realmId, entity: e, id })
  }
  if (Array.isArray(body)) {
    // CloudEvents: [{ type: 'qbo.invoice.updated.v1', intuitaccountid, intuitentityid, ... }]
    for (const ev of body.slice(0, 200) as { type?: string; intuitaccountid?: string; intuitentityid?: string }[]) add(ev?.intuitaccountid, /^qbo\.([a-z]+)\./i.exec(ev?.type ?? '')?.[1], ev?.intuitentityid)
  } else {
    const notes = (body as { eventNotifications?: { realmId?: string; dataChangeEvent?: { entities?: { name?: string; id?: string }[] } }[] })?.eventNotifications
    for (const n of (Array.isArray(notes) ? notes : []).slice(0, 50)) for (const e of (n?.dataChangeEvent?.entities ?? []).slice(0, 200)) add(n.realmId, e?.name, e?.id)
  }
  return out
}

/** Make the matching open cases due now and queue their checks. Returns the number of cases targeted. */
export async function handleQuickBooksWebhook(rawBody: string, signature: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const verifier = officeConfig.quickbooksWebhookVerifier
  if (!verifier) return { status: 503, body: { ok: false, error: 'needs_setup' } }
  if (!verifyIntuitSignature(rawBody, signature, verifier)) return { status: 401, body: { ok: false, error: 'invalid_signature' } }
  let parsed: unknown
  try { parsed = JSON.parse(rawBody) } catch { return { status: 400, body: { ok: false, error: 'invalid_json' } } }
  const changes = parseQuickBooksChanges(parsed)
  const targeted = new Set<string>()
  const now = new Date()
  for (const ch of changes) {
    const cases = await admin(async db => {
      const conns = await db.query<{ id: string; org_id: string }>(`select id, org_id from office_connections where provider = 'quickbooks' and status = 'active' and not is_synthetic and external_account_id = $1`, [ch.realmId])
      const rows: { id: string; org_id: string }[] = []
      for (const c of conns) {
        rows.push(...(ch.entity === 'invoice'
          // the case linked to this invoice (opened by the agent or by discovery)
          ? await db.query<{ id: string; org_id: string }>(`update cases set next_check_at = $3 where org_id = $1 and kind = 'invoice_overdue' and status not in ('resolved','cancelled')
              and id in (select case_id from case_links where org_id = $1 and ref_type = 'qbo_invoice' and ref_id = $2) returning id, org_id`, [c.org_id, `${ch.realmId}:${ch.id}`, now.toISOString()])
          // a payment names its invoices only on a read: every open invoice case of this company is checked
          : await db.query<{ id: string; org_id: string }>(`update cases set next_check_at = $3 where id in (select id from cases where org_id = $1 and kind = 'invoice_overdue' and status not in ('resolved','cancelled')
              and verification->'rule'->>'realmId' = $2 order by next_check_at nulls first limit 50) returning id, org_id`, [c.org_id, ch.realmId, now.toISOString()])))
      }
      return rows
    })
    for (const c of cases) {
      if (targeted.has(c.id)) continue
      targeted.add(c.id)
      await enqueue({ kind: 'case.check', orgId: c.org_id, payload: { caseId: c.id }, idempotencyKey: `${c.id}@${now.toISOString()}` })
    }
  }
  return { status: 200, body: { ok: true, changes: changes.length, targeted: targeted.size } }
}
