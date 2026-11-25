import { NextResponse } from 'next/server'
import { admin } from '@/lib/db'
import { resolveActor, errorResponse, readJson, HttpError, ipOf } from '@/lib/store/request'
import { acceptorId, agreementStatus, legalGateMode, recordAcceptance, syncLegalDocuments } from '@/lib/legal'
import { hasProduct, isProduct, type Product } from '@/lib/products'
import type { Actor } from '@/lib/engine/actor'

export const dynamic = 'force-dynamic'

async function productFor(actor: Exclude<Actor, { kind: 'staff' }>, asked: string | null): Promise<Product> {
  if (isProduct(asked)) return asked
  return admin(async db => (!(await hasProduct(db, actor.orgId, 'commerce')) && (await hasProduct(db, actor.orgId, 'office')) ? 'office' : 'commerce'))
}

/** The agreements this organization's product needs, each with its full text, fingerprint and whether it is accepted. ?product=commerce|office */
export async function GET(req: Request) {
  try {
    const actor = await resolveActor(req)
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'agreements are accepted by the merchant')
    const product = await productFor(actor, new URL(req.url).searchParams.get('product'))
    const userId = acceptorId(actor)
    const status = await admin(async db => { await syncLegalDocuments(db); return agreementStatus(db, actor.orgId, userId, product) })
    return NextResponse.json({
      ok: true, mode: legalGateMode(), product,
      documents: status.map(s => ({ key: s.doc.key, title: s.doc.title, version: s.doc.version, sha256: s.doc.sha256, effectiveDate: s.doc.effectiveDate, draft: s.doc.draft || !s.published, published: s.published, scope: s.doc.scope, accepted: s.accepted, acceptedAt: s.acceptedAt, content: s.doc.content })),
      missing: status.filter(s => !s.accepted).map(s => s.doc.key),
    })
  } catch (e) { return errorResponse(e) }
}

/** Clickwrap: { product, agreed: true, documents: [{ key, version, sha256 }] } for the exact texts shown. */
export async function POST(req: Request) {
  try {
    const actor = await resolveActor(req, { mutating: true })
    if (actor.kind === 'staff') throw new HttpError(403, 'forbidden', 'Deploi staff cannot accept agreements for a merchant')
    const body = await readJson(req)
    if (body.agreed !== true) throw new HttpError(400, 'invalid_input', 'tick the box to accept')
    const product = await productFor(actor, typeof body.product === 'string' ? body.product : null)
    const documents = (Array.isArray(body.documents) ? body.documents : []).slice(0, 20).map(d => {
      const o = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>
      return { key: String(o.key ?? ''), version: String(o.version ?? ''), sha256: String(o.sha256 ?? '') }
    })
    const accepted = await admin(db => recordAcceptance(db, {
      orgId: actor.orgId, userId: acceptorId(actor), userEmail: actor.kind === 'profile' ? actor.session.email : null, product, documents,
      ip: ipOf(req), userAgent: req.headers.get('user-agent'),
    }))
    return NextResponse.json({ ok: true, accepted })
  } catch (e) { return errorResponse(e) }
}
