/**
 * The Competitor & Trend Watcher step of an agent run. For each store the merchant chose:
 *   read its public pages within the budget -> record the check -> compare with what was known ->
 *   store products, change-only observations and changes -> build insights.
 * Then look for patterns across stores in the window, and (if granted) draft an alert for the meaningful
 * findings. A failed or partial check never produces "removed", "out of stock" or "new" findings.
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import type { AgentPolicy, CompetitorPolicy } from '../agents/policy'
import { COMPETITOR_SOURCES } from './sources/shopify-public'
import { diffSnapshot } from './diff'
import { crossStorePatterns, storeInsights, unavailableInsight, type InsightDraft, type StoreRef, type WindowLaunch } from './insights'
import { productSummary } from './normalize'
import type { KnownProduct, KnownStore, StoreSnapshot } from './types'
import { competitorAlert } from './alerts'
import { createAgentMessages, processQueue } from '../email/engine'
import { env } from '../env'
import { canonicalJson } from '../engine/hash'

export type CompetitorRunCounts = { storesChecked: number; storesComplete: number; storesPartial: number; storesFailed: number; insightsCreated: number; meaningful: number; requests: number; alertDrafted: boolean }

type StoreRow = { id: string; org_id: string; origin: string; domain: string; label: string; bestseller_handle: string | null; source_key: string; status: string; currency: string | null; baseline_at: string | null; last_check_complete: boolean; bestseller_observed: boolean; last_success_at: string | null; consecutive_failures: number; failing_since: string | null }

const delayMs = () => { const n = Number(process.env.COMPETITOR_REQUEST_DELAY_MS ?? 1000); return Number.isFinite(n) && n >= 0 ? Math.min(n, 10000) : 1000 }

/** Make the stored list of watched stores match the policy. Removed stores keep their history. */
export async function syncWatchedStores(db: Db, orgId: string, agentId: string, c: CompetitorPolicy): Promise<StoreRow[]> {
  const domains = c.stores.map(st => new URL(st.url).hostname)
  for (const st of c.stores) {
    const domain = new URL(st.url).hostname
    await db.query(`insert into competitor_stores (org_id, agent_id, origin, domain, label, bestseller_handle) values ($1,$2,$3,$4,$5,$6)
      on conflict (agent_id, domain) do update set label = excluded.label, bestseller_handle = excluded.bestseller_handle, origin = excluded.origin,
        status = case when competitor_stores.status = 'removed' then 'pending' else competitor_stores.status end`, [orgId, agentId, st.url, domain, st.label, st.bestsellerCollection])
  }
  await db.query(`update competitor_stores set status = 'removed', status_reason = 'no longer in the watch list' where agent_id = $1 and not (domain = any($2::text[])) and status <> 'removed'`, [agentId, domains])
  return db.query<StoreRow>(`select * from competitor_stores where agent_id = $1 and status <> 'removed' order by created_at`, [agentId])
}

async function knownStore(db: Db, s: StoreRow): Promise<KnownStore> {
  const rows = await db.query<{ external_id: string; title: string; url: string; product_type: string; tags: string[]; published_at: string | null; first_seen_at: string; in_baseline: boolean; listed: boolean; missing_streak: number; currency: string | null; variants: KnownProduct['variants']; bestseller_rank: number | null }>(
    `select external_id, title, url, product_type, tags, published_at, first_seen_at, in_baseline, listed, missing_streak, currency, variants, bestseller_rank from competitor_products where store_id = $1`, [s.id])
  return {
    baselineAt: s.baseline_at, lastCheckComplete: s.last_check_complete, bestsellerObservedBefore: s.bestseller_observed,
    products: new Map(rows.map(r => [r.external_id, { externalId: r.external_id, title: r.title, url: r.url, productType: r.product_type, tags: r.tags, publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
      firstSeenAt: new Date(r.first_seen_at).toISOString(), inBaseline: r.in_baseline, listed: r.listed, missingStreak: r.missing_streak, currency: r.currency, variants: r.variants, bestsellerRank: r.bestseller_rank }])),
  }
}

async function saveInsight(db: Db, orgId: string, agentId: string, runId: string | null, d: InsightDraft): Promise<{ id: string; meaningful: boolean } | null> {
  const r = await db.one<{ id: string }>(`insert into competitor_insights (org_id, agent_id, run_id, kind, dedupe_key, headline, basis, facts, stores, products, sources, period_start, period_end, inference, limitations, next_action, meaningful)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) on conflict (agent_id, dedupe_key) do nothing returning id`,
    [orgId, agentId, runId, d.kind, d.dedupeKey, d.headline.slice(0, 300), d.basis, JSON.stringify(d.facts), JSON.stringify(d.stores), JSON.stringify(d.products), JSON.stringify(d.sources), d.periodStart, d.periodEnd, d.inference, JSON.stringify(d.limitations), d.nextAction, d.meaningful])
  return r ? { id: r.id, meaningful: d.meaningful } : null
}

/** Persist one successful check: products (batched), change-only observations, changes, store state. */
async function persistCheck(db: Db, s: StoreRow, checkId: string, agentId: string, snap: StoreSnapshot, result: ReturnType<typeof diffSnapshot>) {
  const at = snap.fetchedAt.toISOString()
  const seen = new Set(snap.products.map(p => p.externalId))
  const byId = new Map(snap.products.map(p => [p.externalId, p]))
  const rows = [...result.products.values()].map(k => {
    const sm = productSummary(k.variants)
    const p = byId.get(k.externalId)
    return { external_id: k.externalId, handle: p?.handle ?? k.url.split('/products/')[1] ?? k.externalId, title: k.title, url: k.url, product_type: k.productType, vendor: p?.vendor ?? '', tags: k.tags,
      published_at: k.publishedAt, first_seen_at: k.firstSeenAt, in_baseline: k.inBaseline, listed: k.listed, missing_streak: k.missingStreak, last_seen: seen.has(k.externalId) ? at : null,
      currency: k.currency, variants: k.variants, price_min: sm.priceMin, price_max: sm.priceMax, on_sale: sm.onSale, available_count: sm.availableCount, availability_known: sm.availabilityKnown, bestseller_rank: k.bestsellerRank }
  })
  const ids = rows.length ? await db.query<{ id: string; external_id: string }>(
    `insert into competitor_products (org_id, store_id, external_id, handle, title, url, product_type, vendor, tags, published_at, first_seen_at, in_baseline, listed, missing_streak, last_seen_at, currency, variants, price_min, price_max, on_sale, available_count, availability_known, bestseller_rank)
     select $1, $2, x.external_id, x.handle, x.title, x.url, x.product_type, x.vendor, x.tags, x.published_at, x.first_seen_at, x.in_baseline, x.listed, x.missing_streak, coalesce(x.last_seen, x.first_seen_at), x.currency, x.variants, x.price_min, x.price_max, x.on_sale, x.available_count, x.availability_known, x.bestseller_rank
     from jsonb_to_recordset($3::jsonb) as x(external_id text, handle text, title text, url text, product_type text, vendor text, tags text[], published_at timestamptz, first_seen_at timestamptz, in_baseline boolean, listed boolean, missing_streak int, last_seen timestamptz,
       currency text, variants jsonb, price_min numeric, price_max numeric, on_sale boolean, available_count int, availability_known int, bestseller_rank int)
     on conflict (store_id, external_id) do update set handle = excluded.handle, title = excluded.title, url = excluded.url, product_type = excluded.product_type, vendor = excluded.vendor, tags = excluded.tags,
       published_at = excluded.published_at, listed = excluded.listed, missing_streak = excluded.missing_streak,
       last_seen_at = case when $4::text[] @> array[excluded.external_id] then $5::timestamptz else competitor_products.last_seen_at end,
       currency = excluded.currency, variants = excluded.variants, price_min = excluded.price_min, price_max = excluded.price_max, on_sale = excluded.on_sale,
       available_count = excluded.available_count, availability_known = excluded.availability_known, bestseller_rank = excluded.bestseller_rank
     returning id, external_id`, [s.org_id, s.id, JSON.stringify(rows), [...seen], at]) : []
  const idOf = new Map(ids.map(r => [r.external_id, r.id]))

  // change-only observation history for the products this check actually saw
  const latest = await db.query<{ id: string; product_id: string; currency: string | null; price_min: string | null; price_max: string | null; on_sale: boolean; available_count: number; availability_known: number; bestseller_rank: number | null; variants: unknown }>(
    `select distinct on (product_id) id, product_id, currency, price_min, price_max, on_sale, available_count, availability_known, bestseller_rank, variants from competitor_observations where store_id = $1 order by product_id, observed_at desc`, [s.id])
  const last = new Map(latest.map(l => [l.product_id, l]))
  const confirm: string[] = []
  const insert: Record<string, unknown>[] = []
  for (const p of snap.products) {
    const pid = idOf.get(p.externalId); if (!pid) continue
    const sm = productSummary(p.variants)
    const k = result.products.get(p.externalId)
    const obs = { product_id: pid, currency: snap.currency, price_min: sm.priceMin, price_max: sm.priceMax, on_sale: sm.onSale, available_count: sm.availableCount, availability_known: sm.availabilityKnown, variant_count: sm.variantCount, bestseller_rank: k?.bestsellerRank ?? null, variants: p.variants }
    const l = last.get(pid)
    const same = l && l.currency === obs.currency && Number(l.price_min) === obs.price_min && Number(l.price_max) === obs.price_max && l.on_sale === obs.on_sale
      && l.available_count === obs.available_count && l.availability_known === obs.availability_known && l.bestseller_rank === obs.bestseller_rank && canonicalJson(l.variants) === canonicalJson(obs.variants)
    if (same) confirm.push(l!.id); else insert.push(obs)
  }
  if (confirm.length) await db.query(`update competitor_observations set last_confirmed_at = $2 where id = any($1::bigint[])`, [confirm, at])
  if (insert.length) await db.query(
    `insert into competitor_observations (org_id, store_id, product_id, check_id, observed_at, last_confirmed_at, currency, price_min, price_max, on_sale, available_count, availability_known, variant_count, bestseller_rank, variants)
     select $1, $2, x.product_id, $3, $4, $4, x.currency, x.price_min, x.price_max, x.on_sale, x.available_count, x.availability_known, x.variant_count, x.bestseller_rank, x.variants
     from jsonb_to_recordset($5::jsonb) as x(product_id uuid, currency text, price_min numeric, price_max numeric, on_sale boolean, available_count int, availability_known int, variant_count int, bestseller_rank int, variants jsonb)`,
    [s.org_id, s.id, checkId, at, JSON.stringify(insert)])
  if (result.changes.length) await db.query(
    `insert into competitor_changes (org_id, agent_id, store_id, check_id, kind, external_id, title, url, observed_at, detail)
     select $1, $2, $3, $4, x.kind, x.external_id, x.title, x.url, x.observed_at, x.detail from jsonb_to_recordset($5::jsonb) as x(kind text, external_id text, title text, url text, observed_at timestamptz, detail jsonb)`,
    [s.org_id, agentId, s.id, checkId, JSON.stringify(result.changes.map(c => ({ kind: c.kind, external_id: c.externalId, title: c.title, url: c.url, observed_at: c.observedAt, detail: c.detail })))])
  await db.query(`update competitor_stores set status = 'supported', status_reason = $2, currency = coalesce($3, currency), store_name = coalesce($4, store_name), baseline_at = $5,
      last_check_complete = $6, bestseller_observed = $7, last_attempt_at = $8, last_success_at = $8, consecutive_failures = 0, failing_since = null where id = $1`,
    [s.id, snap.complete ? null : snap.incompleteReason, snap.currency, snap.storeName, result.baselineAt, snap.complete, result.bestsellerObserved, at])
}

export async function runCompetitorStep(input: { agentId: string; orgId: string; agentName: string; runId: string; policy: AgentPolicy; actor: string; now: Date }): Promise<CompetitorRunCounts> {
  const c = input.policy.competitor!
  const counts: CompetitorRunCounts = { storesChecked: 0, storesComplete: 0, storesPartial: 0, storesFailed: 0, insightsCreated: 0, meaningful: 0, requests: 0, alertDrafted: false }
  const stores = await admin(db => syncWatchedStores(db, input.orgId, input.agentId, c))
  const created: { id: string; meaningful: boolean }[] = []
  for (const s of stores) {
    const factory = COMPETITOR_SOURCES[s.source_key]
    const ref: StoreRef = { id: s.id, label: s.label, origin: s.origin, currency: s.currency }
    if (!factory) {
      await admin(async db => {
        await db.query(`update competitor_stores set status = 'unsupported', status_reason = $2, last_attempt_at = $3 where id = $1`, [s.id, `no source "${s.source_key}" is available`, input.now.toISOString()])
        const i = await saveInsight(db, input.orgId, input.agentId, input.runId, unavailableInsight({ store: ref, status: 'unsupported', reason: 'No supported source can read this store.', since: s.failing_since ?? input.now.toISOString(), checkedAt: input.now.toISOString() }))
        if (i) created.push(i)
      })
      counts.storesFailed++
      continue
    }
    counts.storesChecked++
    const known = await admin(db => knownStore(db, s))
    const res = await factory().collect({ origin: s.origin, bestsellerHandle: s.bestseller_handle, budget: { maxRequests: c.budget.maxRequestsPerStore, maxProducts: c.budget.maxProductsPerStore, delayMs: delayMs() } })
    const at = input.now.toISOString()
    if (!res.ok) {
      counts.storesFailed++
      counts.requests += res.requestsUsed
      await admin(async db => {
        await db.query(`insert into competitor_checks (org_id, agent_id, store_id, run_id, outcome, status, reason, requests_used, finished_at) values ($1,$2,$3,$4,'failed',$5,$6,$7,now())`,
          [s.org_id, input.agentId, s.id, input.runId, res.status, res.reason, res.requestsUsed])
        const failures = s.consecutive_failures + 1
        const since = s.failing_since ?? at
        await db.query(`update competitor_stores set status = $2, status_reason = $3, last_attempt_at = $4, consecutive_failures = $5, failing_since = $6 where id = $1`, [s.id, res.status, res.reason, at, failures, since])
        // one honest note per outage: immediately for a store that cannot be read at all, after two failures otherwise
        if (res.status === 'unsupported' || res.status === 'blocked' || failures >= 2) {
          const i = await saveInsight(db, input.orgId, input.agentId, input.runId, unavailableInsight({ store: ref, status: res.status, reason: res.reason, since, checkedAt: at }))
          if (i) created.push(i)
        }
      })
      continue
    }
    const snap = { ...res.snapshot, fetchedAt: input.now }
    counts.requests += snap.requestsUsed
    if (snap.complete) counts.storesComplete++; else counts.storesPartial++
    const result = diffSnapshot(known, snap, { bestsellerTopN: 10 })
    await admin(async db => {
      const check = await db.one<{ id: string }>(`insert into competitor_checks (org_id, agent_id, store_id, run_id, outcome, status, reason, product_count, requests_used, bestseller_status, currency, source_urls, finished_at)
        values ($1,$2,$3,$4,$5,'supported',$6,$7,$8,$9,$10,$11,now()) returning id`,
        [s.org_id, input.agentId, s.id, input.runId, snap.complete ? 'complete' : 'partial', snap.incompleteReason, snap.products.length, snap.requestsUsed, snap.bestseller.status, snap.currency, snap.sourceUrls.slice(0, 40)])
      await persistCheck(db, s, check!.id, input.agentId, snap, result)
      for (const d of storeInsights({ runId: input.runId, store: { ...ref, currency: snap.currency ?? s.currency }, changes: result.changes, previousCheckAt: s.last_success_at ? new Date(s.last_success_at).toISOString() : null, checkedAt: at, sourceUrls: snap.sourceUrls, prefs: c.alerts })) {
        const i = await saveInsight(db, input.orgId, input.agentId, input.runId, d)
        if (i) created.push(i)
      }
    })
  }

  // patterns across stores: launches within the window, at stores still watched
  await admin(async db => {
    const since = new Date(input.now.getTime() - c.alerts.windowDays * 864e5).toISOString()
    const launches = await db.query<WindowLaunch>(
      `select ch.store_id as "storeId", st.label as store, ch.external_id as "externalId", coalesce(cp.title, ch.title) as title, ch.url, coalesce(cp.product_type, '') as "productType",
         coalesce(cp.tags, '{}') as tags, ch.observed_at as "observedAt", cp.bestseller_rank as "bestsellerRank", (cp.bestseller_rank is not null) as "onBestsellerList"
       from competitor_changes ch join competitor_stores st on st.id = ch.store_id
       left join competitor_products cp on cp.store_id = ch.store_id and cp.external_id = ch.external_id
       where ch.agent_id = $1 and ch.kind = 'launch' and ch.observed_at >= $2 and st.status <> 'removed'`, [input.agentId, since])
    for (const d of crossStorePatterns({ launches: launches.map(l => ({ ...l, observedAt: new Date(l.observedAt).toISOString() })), keywords: c.keywords, categories: c.categories, prefs: c.alerts, storesWatched: stores.length, now: input.now.toISOString() })) {
      const i = await saveInsight(db, input.orgId, input.agentId, input.runId, d)
      if (i) created.push(i)
    }
    await audit(db, { orgId: input.orgId, entityType: 'run', entityId: input.runId, event: 'competitor.checked', actor: input.actor, detail: { agent_id: input.agentId, ...counts, insights: created.length } })
  })
  counts.insightsCreated = created.length
  counts.meaningful = created.filter(x => x.meaningful).length

  // alert: only when granted, only meaningful findings not alerted before, drafted or sent under the agent's own email permission
  const e = input.policy.email
  if (e?.tasks.includes('competitor_alert') && counts.meaningful) {
    const rows = await admin(db => db.query<{ id: string; headline: string; basis: string; next_action: string }>(
      `select id, headline, basis, next_action from competitor_insights where agent_id = $1 and meaningful and alerted_at is null and status = 'new' order by created_at limit 20`, [input.agentId]))
    if (rows.length) {
      const d = competitorAlert(e, { runId: input.runId, agentId: input.agentId, agentName: input.agentName, appUrl: (env.appUrl || 'http://localhost:3000').replace(/\/$/, ''), at: input.now, insights: rows })
      const r = await createAgentMessages({ agentId: input.agentId, runId: input.runId, drafts: [d], actor: input.actor, now: input.now })
      if (r.created.length) {
        counts.alertDrafted = true
        await admin(db => db.query(`update competitor_insights set alerted_at = $2 where id = any($1::uuid[])`, [rows.map(x => x.id), input.now.toISOString()]))
        await processQueue({ agentId: input.agentId, actor: input.actor, now: input.now })
      }
    }
  }
  return counts
}
