/** Competitor watcher reads for the merchant UI. Every query runs as the actor, so RLS limits it to their organization. */
import { withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import { COMPETITOR_SOURCES, PLANNED_PROVIDERS, shopifyPublicSource } from './sources/shopify-public'

export async function competitorOverview(actor: Actor, agentId: string, opts: { insightLimit?: number } = {}) {
  return withActor(actor, async db => {
    const agent = await db.one<{ id: string }>(`select id from agents where id = $1 and status <> 'deleted'`, [agentId])
    if (!agent) throw new EngineError('not_found', 'agent not found')
    const stores = await db.query(
      `select s.id, s.origin, s.domain, s.label, s.bestseller_handle, s.source_key, s.status, s.status_reason, s.currency, s.store_name, s.baseline_at, s.last_check_complete, s.bestseller_observed,
         s.last_attempt_at, s.last_success_at, s.consecutive_failures, s.failing_since,
         (select count(*)::int from competitor_products p where p.store_id = s.id and p.listed) as products_listed,
         (select json_build_object('outcome', c.outcome, 'status', c.status, 'reason', c.reason, 'product_count', c.product_count, 'requests_used', c.requests_used, 'bestseller_status', c.bestseller_status, 'finished_at', c.finished_at)
            from competitor_checks c where c.store_id = s.id order by c.started_at desc limit 1) as last_check
       from competitor_stores s where s.agent_id = $1 and s.status <> 'removed' order by s.created_at`, [agentId])
    const insights = await db.query(
      `select id, kind, headline, basis, facts, stores, products, sources, period_start, period_end, inference, limitations, next_action, meaningful, status, handoff, alerted_at, created_at
       from competitor_insights where agent_id = $1 and status <> 'dismissed' order by created_at desc, meaningful desc limit $2`, [agentId, opts.insightLimit ?? 60])
    const source = shopifyPublicSource()
    return { stores, insights, sources: Object.keys(COMPETITOR_SOURCES).map(k => (k === source.key ? { key: k, label: source.label, coverage: source.coverage, status: 'available' } : { key: k, label: k, coverage: [], status: 'available' })), providers: PLANNED_PROVIDERS }
  })
}

/** Products across watched stores, optionally filtered by a word, for the comparison view. Prices are never converted between currencies. */
export async function competitorProducts(actor: Actor, agentId: string, opts: { q?: string | null; storeId?: string | null; limit?: number } = {}) {
  return withActor(actor, async db => {
    const agent = await db.one<{ id: string }>(`select id from agents where id = $1 and status <> 'deleted'`, [agentId])
    if (!agent) throw new EngineError('not_found', 'agent not found')
    const q = (opts.q ?? '').trim().toLowerCase().slice(0, 60)
    return db.query(
      `select p.id, p.store_id, s.label as store, p.title, p.url, p.product_type, p.tags, p.published_at, p.first_seen_at, p.in_baseline, p.listed, p.last_seen_at,
         p.currency, p.price_min, p.price_max, p.on_sale, p.available_count, p.availability_known, p.bestseller_rank
       from competitor_products p join competitor_stores s on s.id = p.store_id
       where s.agent_id = $1 and s.status <> 'removed' and ($2::uuid is null or p.store_id = $2)
         and ($3 = '' or lower(p.title) like '%' || $3 || '%' or lower(p.product_type) like '%' || $3 || '%' or $3 = any(p.tags))
       order by p.bestseller_rank nulls last, p.first_seen_at desc limit $4`, [agentId, opts.storeId ?? null, q, Math.min(opts.limit ?? 100, 300)])
  })
}

/** Price and availability history of one product (change points with the time each was first and last seen). */
export async function competitorProductHistory(actor: Actor, agentId: string, productId: string) {
  return withActor(actor, async db => {
    const product = await db.one(`select p.id, p.title, p.url, p.currency, s.label as store, s.id as store_id from competitor_products p join competitor_stores s on s.id = p.store_id where p.id = $1 and s.agent_id = $2`, [productId, agentId])
    if (!product) throw new EngineError('not_found', 'product not found')
    const history = await db.query(`select observed_at, last_confirmed_at, currency, price_min, price_max, on_sale, available_count, availability_known, variant_count, bestseller_rank from competitor_observations where product_id = $1 order by observed_at desc limit 200`, [productId])
    const checks = await db.query(`select outcome, status, reason, finished_at from competitor_checks where store_id = $1 order by started_at desc limit 30`, [(product as { store_id: string }).store_id])
    return { product, history, checks }
  })
}
