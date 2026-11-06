/**
 * Generic undo kinds any pack can use (importing this module registers them). Each restores the values a record
 * had before the agent changed it, after checking the record belongs to the token's organization.
 *
 *   synthetic.product.restore  { connectionId, productId, before: { tags?, status?, title? } }
 *   synthetic.variant.restore  { connectionId, variantId, before: { inventoryPolicy?, price?, compareAtPrice?, sku? } }
 *
 * Synthetic kinds act only on a synthetic store (is_synthetic); a real store write is undone by a kind that
 * goes through the connector's own gates (registered by the pack that makes the write).
 */
import type { Db } from '../db'
import { registerUndo } from './index'

type Conn = { id: string; org_id: string; is_synthetic: boolean }
async function syntheticConn(db: Db, orgId: unknown, connectionId: unknown): Promise<Conn | string> {
  if (typeof connectionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(connectionId)) return 'the store is not named'
  const c = await db.one<Conn>('select id, org_id, is_synthetic from store_connections where id = $1', [connectionId])
  if (!c || c.org_id !== orgId) return 'the store was not found'
  if (!c.is_synthetic) return 'this undo works only on a synthetic store'
  return c
}
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

registerUndo('synthetic.product.restore', async (db, p) => {
  const c = await syntheticConn(db, p.orgId, p.connectionId)
  if (typeof c === 'string') return { ok: false, detail: c }
  const before = obj(p.before)
  const { mutateSynthetic, getSyntheticState } = await import('../connectors/shopify/synthetic')
  let found = false
  await mutateSynthetic(c.id, s => {
    const pr = s.products.find(x => x.id === p.productId)
    if (!pr) return
    found = true
    if (Array.isArray(before.tags)) pr.tags = before.tags.map(String)
    if (typeof before.status === 'string' && ['ACTIVE', 'DRAFT', 'ARCHIVED', 'UNLISTED'].includes(before.status)) pr.status = before.status as typeof pr.status
    if (typeof before.title === 'string') pr.title = before.title
    pr.updatedAt = new Date().toISOString()
  })
  if (!found) return { ok: false, detail: 'the product no longer exists' }
  const fresh = (await getSyntheticState(c.id))?.products.find(x => x.id === p.productId)
  return { ok: true, detail: `Restored "${fresh?.title ?? p.productId}" (fresh read: tags ${fresh?.tags.join(', ') || 'none'}, status ${fresh?.status ?? 'unknown'})` }
})

registerUndo('synthetic.variant.restore', async (db, p) => {
  const c = await syntheticConn(db, p.orgId, p.connectionId)
  if (typeof c === 'string') return { ok: false, detail: c }
  const before = obj(p.before)
  const { mutateSynthetic, getSyntheticState } = await import('../connectors/shopify/synthetic')
  let found = false
  await mutateSynthetic(c.id, s => {
    for (const pr of s.products) for (const v of pr.variants) {
      if (v.id !== p.variantId) continue
      found = true
      if (before.inventoryPolicy === 'CONTINUE' || before.inventoryPolicy === 'DENY') v.inventoryPolicy = before.inventoryPolicy
      if (typeof before.price === 'string') v.price = before.price
      if (typeof before.compareAtPrice === 'string' || before.compareAtPrice === null) v.compareAtPrice = before.compareAtPrice as string | null
      if (typeof before.sku === 'string' || before.sku === null) v.sku = before.sku as string | null
      pr.updatedAt = new Date().toISOString()
    }
  })
  if (!found) return { ok: false, detail: 'the variant no longer exists' }
  const v = (await getSyntheticState(c.id))?.products.flatMap(x => x.variants).find(x => x.id === p.variantId)
  return { ok: true, detail: `Restored the variant (fresh read: selling when out of stock ${v?.inventoryPolicy === 'CONTINUE' ? 'on' : 'off'}, price ${v?.price ?? 'unknown'})` }
})
