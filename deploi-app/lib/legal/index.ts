/**
 * Legal acceptance: which agreements a product needs, who has accepted which exact text, and the gate
 * that refuses the server entry points (connecting a store, creating or granting an agent, starting
 * billing) until they are accepted.
 *
 *   LEGAL_GATE=off      (default) nothing is required; the clickwrap page still works.
 *   LEGAL_GATE=draft    pilots must accept the current DRAFT text, recorded as document_status 'draft'.
 *   LEGAL_GATE=enforce  the current text must be published (legal_documents.status = 'published', set by
 *                       hand after counsel review; nothing in the app sets it) and accepted.
 *
 * An acceptance matches a document by key, version AND sha256: editing a document, even without a new
 * version label, requires everyone to accept again. Acceptances are append-only (migration 42).
 * Organization-scoped documents (terms, DPA, AI agent terms, pilot) are accepted once for the
 * organization by an authorized user; user-scoped ones (privacy notice, acceptable use) by each person.
 */
import type { Db } from '../db'
import { admin } from '../db'
import type { Actor } from '../engine/actor'
import { HttpError } from '../store/request'
import type { Product } from '../products'
import { loadLegalDocuments, type LegalDocument } from './documents'

export { loadLegalDocuments, legalDocument, DRAFT_BANNER, LEGAL_MANIFEST, type LegalDocument, type LegalKey } from './documents'

export type LegalGateMode = 'off' | 'draft' | 'enforce'
export function legalGateMode(env: Record<string, string | undefined> = process.env): LegalGateMode {
  const v = (env.LEGAL_GATE ?? '').trim().toLowerCase()
  return v === 'draft' || v === 'enforce' ? v : 'off'
}
const pilotRequired = () => (process.env.LEGAL_REQUIRE_PILOT ?? '').trim() === 'true'

/** The agreements a customer of `product` must accept (pilot agreement only when LEGAL_REQUIRE_PILOT=true). */
export function requiredAgreements(product: Product, docs: LegalDocument[] = loadLegalDocuments()): LegalDocument[] {
  return docs.filter(d => d.requiredFor.includes(product) && (!d.pilotOnly || pilotRequired()))
}

/** Record every document version the app serves (as draft; never as published). Idempotent. */
export async function syncLegalDocuments(db: Db, docs: LegalDocument[] = loadLegalDocuments()) {
  for (const d of docs) {
    await db.query(`insert into legal_documents (key, version, sha256, title) values ($1,$2,$3,$4) on conflict (key, version, sha256) do nothing`, [d.key, d.version, d.sha256, d.title])
  }
}

/** Published status of the exact current text of each document (false when the registry has no published row). */
async function publishedSet(db: Db, docs: LegalDocument[]): Promise<Set<string>> {
  if (!docs.length) return new Set()
  const rows = await db.query<{ key: string; version: string; sha256: string }>(
    `select key, version, sha256 from legal_documents where status = 'published' and key = any($1::text[])`, [docs.map(d => d.key)])
  return new Set(rows.map(r => `${r.key}|${r.version}|${r.sha256}`))
}
const idOf = (d: Pick<LegalDocument, 'key' | 'version' | 'sha256'>) => `${d.key}|${d.version}|${d.sha256}`

export type AgreementStatus = { doc: LegalDocument; accepted: boolean; published: boolean; acceptedAt: string | null }

/** Each required document with whether this user (or, for org documents, anyone in the organization) accepted its current text. */
export async function agreementStatus(db: Db, orgId: string, userId: string, product: Product): Promise<AgreementStatus[]> {
  const docs = requiredAgreements(product)
  const published = await publishedSet(db, docs)
  const rows = await db.query<{ document_key: string; document_version: string; document_sha256: string; user_id: string; accepted_at: string }>(
    `select document_key, document_version, document_sha256, user_id, accepted_at::text from legal_acceptances where org_id = $1 and document_key = any($2::text[]) order by accepted_at desc`,
    [orgId, docs.map(d => d.key)])
  return docs.map(doc => {
    const hit = rows.find(r => r.document_key === doc.key && r.document_version === doc.version && r.document_sha256 === doc.sha256 && (doc.scope === 'org' || r.user_id === userId))
    return { doc, accepted: Boolean(hit), published: published.has(idOf(doc)), acceptedAt: hit?.accepted_at ?? null }
  })
}

/** The required documents whose current text this user has not accepted (for org documents: nobody in the organization). */
export async function missingAcceptances(db: Db, orgId: string, userId: string, product: Product = 'commerce'): Promise<LegalDocument[]> {
  return (await agreementStatus(db, orgId, userId, product)).filter(s => !s.accepted).map(s => s.doc)
}

export class AgreementsRequired extends HttpError {
  constructor(public missing: string[], message: string) { super(428, 'agreements_required', message); this.name = 'AgreementsRequired' }
}

/** Throws unless every agreement `product` needs is accepted (and, under enforce, published). No-op when LEGAL_GATE=off. */
export async function assertAgreementsAccepted(db: Db, orgId: string, userId: string, product: Product, mode: LegalGateMode = legalGateMode()) {
  if (mode === 'off') return
  const status = await agreementStatus(db, orgId, userId, product)
  if (mode === 'enforce') {
    const unpublished = status.filter(s => !s.published).map(s => s.doc.key)
    if (unpublished.length) throw new AgreementsRequired(unpublished, `the ${unpublished.join(', ')} terms are not published yet, so this cannot be enabled; contact Deploi`)
  }
  const missing = status.filter(s => !s.accepted).map(s => s.doc)
  if (missing.length) throw new AgreementsRequired(missing.map(d => d.key), `accept ${missing.map(d => d.title).join(', ')} at /store/legal first`)
}

/** The person acting, as stored in legal_acceptances.user_id. Staff never accept for a merchant. */
export function acceptorId(actor: Exclude<Actor, { kind: 'staff' }>): string {
  return actor.kind === 'profile' ? actor.session.uid : `shopify:${actor.shop}:${actor.userId}`
}

/**
 * Route helper (one line at each gated entry point). Staff are skipped: staff actors are refused by the
 * routes' own checks. Reads as the service role after the actor was resolved for its own organization.
 */
export async function requireAgreements(actor: Actor, product: Product): Promise<void> {
  const mode = legalGateMode()
  if (mode === 'off' || actor.kind === 'staff') return
  await admin(db => assertAgreementsAccepted(db, actor.orgId, acceptorId(actor), product, mode))
}

export type AcceptanceInput = {
  orgId: string; userId: string; userEmail?: string | null; product: Product
  documents: { key: string; version: string; sha256: string }[]
  ip?: string | null; userAgent?: string | null
}

/**
 * Record clickwrap acceptance of the exact texts shown. Each entry must name a current required
 * document's key, version and sha256 (stale or unknown texts are refused). Under enforce, only
 * published texts can be accepted; otherwise the acceptance is recorded as of a draft.
 */
export async function recordAcceptance(db: Db, input: AcceptanceInput, mode: LegalGateMode = legalGateMode()) {
  const required = requiredAgreements(input.product)
  if (!input.documents.length) throw new HttpError(400, 'invalid_input', 'choose the documents you accept')
  await syncLegalDocuments(db)
  const published = await publishedSet(db, required)
  const out: { key: string; version: string; status: 'draft' | 'published' }[] = []
  for (const d of input.documents) {
    const doc = required.find(r => r.key === d.key)
    if (!doc) throw new HttpError(400, 'invalid_input', `unknown document ${String(d.key).slice(0, 40)}`)
    if (doc.version !== d.version || doc.sha256 !== d.sha256) throw new HttpError(409, 'document_changed', `${doc.title} changed since it was shown; read the current text and accept again`)
    const status = published.has(idOf(doc)) ? 'published' : 'draft'
    if (mode === 'enforce' && status !== 'published') throw new HttpError(409, 'not_published', `${doc.title} is not published yet`)
    await db.query(
      `insert into legal_acceptances (org_id, user_id, user_email, document_key, document_version, document_sha256, document_status, product, method, ip, user_agent)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'clickwrap',$9,$10)`,
      [input.orgId, input.userId, input.userEmail ?? null, doc.key, doc.version, doc.sha256, status, input.product, input.ip ?? null, input.userAgent?.slice(0, 512) ?? null])
    out.push({ key: doc.key, version: doc.version, status })
  }
  return out
}
