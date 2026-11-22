/**
 * A synthetic case for demos and end-to-end tests, opened only on SYNTHETIC stores through the demo
 * controls (POST /api/store/demo { action: 'open_case' }, DEMO_CONTROLS=true). It walks the real lifecycle:
 *
 *   detected -> awaiting_approval (the exact change is shown) -> approve -> executing (the tag is removed
 *   in the synthetic store) -> verifying (a fresh read of the synthetic store) -> resolved with that read as
 *   evidence. Reject cancels the case and changes nothing.
 *
 * The problem is a product tagged `needs-review` in the synthetic catalogue. Nothing here can reach a real store:
 * the connection must be is_synthetic, checked when the case is opened and again when it is approved.
 */
import { admin } from '../db'
import { EngineError } from '../engine/errors'
import { openCase, transitionCase, recordAction, resolveCase, type CaseRow } from './index'
import { registerCaseDecision } from './decisions'

export const DEMO_CASE_KIND = 'demo_synthetic_review'
export const DEMO_TAG = 'needs-review'

type Conn = { id: string; org_id: string; is_synthetic: boolean }
type Rec = { connectionId: string; productId: string; productTitle: string }

function recOf(c: CaseRow): Rec {
  const r = c.records.find(x => x.type === 'synthetic_product')
  const conn = c.records.find(x => x.type === 'store_connection')
  if (!r || !conn) throw new EngineError('invalid_input', 'this case has no synthetic product')
  return { connectionId: conn.id, productId: r.id, productTitle: r.label ?? r.id }
}

async function syntheticConn(id: string, orgId: string): Promise<Conn> {
  const conn = await admin(db => db.one<Conn>('select id, org_id, is_synthetic from store_connections where id = $1', [id]))
  if (!conn || conn.org_id !== orgId) throw new EngineError('not_found', 'connection not found')
  if (!conn.is_synthetic) throw new EngineError('forbidden', 'synthetic cases exist only on synthetic stores')
  return conn
}

/** Tag a product of the synthetic store and open a case for it, waiting for the owner's decision. */
export async function openSyntheticCase(connectionId: string, orgId: string, actor: string): Promise<CaseRow> {
  const conn = await syntheticConn(connectionId, orgId)
  const { mutateSynthetic } = await import('../connectors/shopify/synthetic')
  let product: { id: string; title: string } | null = null
  await mutateSynthetic(conn.id, s => {
    const p = s.products.find(x => x.status === 'ACTIVE') ?? s.products[0]
    if (!p) throw new EngineError('invalid_input', 'the synthetic store has no products')
    if (!p.tags.includes(DEMO_TAG)) p.tags = [...p.tags, DEMO_TAG]
    p.updatedAt = new Date().toISOString()
    product = { id: p.id, title: p.title }
  })
  const p = product as unknown as { id: string; title: string }
  const now = new Date().toISOString()
  return admin(async db => {
    const { case: c } = await openCase(db, {
      orgId, suite: 'commerce', kind: DEMO_CASE_KIND, sourceApp: 'shopify', dedupeKey: `demo:${conn.id}:${p.id}`,
      title: `Synthetic test: "${p.title}" is tagged ${DEMO_TAG}`,
      problem: `The synthetic test store has the product "${p.title}" tagged "${DEMO_TAG}". This is a test case on a synthetic store, used to show the full lifecycle.`,
      whyItMatters: 'Test only: shows how Deploi carries a problem from discovery to a verified outcome. No real store is involved.',
      priority: 'normal',
      evidence: [{ label: `Read the synthetic store: "${p.title}" has the tag "${DEMO_TAG}"`, source: 'shopify_synthetic', observedAt: now, ref: { type: 'synthetic_product', id: p.id } }],
      records: [{ type: 'synthetic_product', id: p.id, label: p.title }, { type: 'store_connection', id: conn.id, label: 'Synthetic test store' }],
      verification: { criteria: `A fresh read of the synthetic store shows "${p.title}" without the tag "${DEMO_TAG}"`, rule: { tagAbsent: DEMO_TAG, productId: p.id } },
      nextAction: `Remove the tag "${DEMO_TAG}" from "${p.title}" in the synthetic store`, actor,
    })
    if (c.status === 'awaiting_approval') return c
    return transitionCase(db, c.id, { to: 'awaiting_approval', actor, reason: 'Waiting for your decision on the exact change', approvalRequired: true })
  })
}

registerCaseDecision(DEMO_CASE_KIND, {
  title: c => c.next_action ?? c.title,
  async approve(c, actor) {
    const r = recOf(c)
    await syntheticConn(r.connectionId, c.org_id)
    const { mutateSynthetic, getSyntheticState } = await import('../connectors/shopify/synthetic')
    await admin(db => transitionCase(db, c.id, { to: 'executing', actor: actor.label, reason: 'Approved: removing the tag', approvalRequired: false }))
    await mutateSynthetic(r.connectionId, s => {
      const p = s.products.find(x => x.id === r.productId)
      if (p) { p.tags = p.tags.filter(t => t !== DEMO_TAG); p.updatedAt = new Date().toISOString() }
    })
    await admin(db => recordAction(db, c.id, { actor: 'Deploi', summary: `Removed the tag "${DEMO_TAG}" from "${r.productTitle}" in the synthetic store`, ref: { type: 'synthetic_product', id: r.productId } }))
    await admin(db => transitionCase(db, c.id, { to: 'verifying', actor: 'Deploi', reason: 'Reading the synthetic store again to confirm' }))
    const fresh = (await getSyntheticState(r.connectionId))?.products.find(x => x.id === r.productId)
    const observedAt = new Date().toISOString()
    if (!fresh || fresh.tags.includes(DEMO_TAG)) {
      await admin(db => transitionCase(db, c.id, { to: 'failed', actor: 'Deploi', reason: 'A fresh read still shows the tag', evidence: [{ label: 'Fresh read: the tag is still there', source: 'shopify_synthetic', observedAt }] }))
      return { status: 'failed', reason: 'a fresh read still shows the tag' }
    }
    await admin(db => resolveCase(db, c.id, {
      actor: 'Deploi', verifiedBy: 'Fresh read of the synthetic store', summary: `"${r.productTitle}" no longer has the tag "${DEMO_TAG}" (confirmed by a fresh read)`,
      evidence: [{ label: `Fresh read: "${r.productTitle}" tags are ${fresh.tags.length ? fresh.tags.join(', ') : 'empty'}`, source: 'shopify_synthetic', observedAt, detail: { tags: fresh.tags }, ref: { type: 'synthetic_product', id: r.productId } }],
    }))
    return { status: 'resolved' }
  },
  async reject(c, actor, reason) {
    await admin(db => transitionCase(db, c.id, { to: 'cancelled', actor: actor.label, reason: reason ? `Rejected: ${reason}` : 'Rejected by the owner; nothing was changed', approvalRequired: false }))
    return { status: 'cancelled' }
  },
})
