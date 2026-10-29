/**
 * The competitor step of an agent run. For each store in the granted policy, one store at a time:
 * read its public information (robots.txt first), compare with what was recorded last time, store the
 * new state and the findings, and log the check. Then look across stores for similar products.
 * Stops between stores if the agent has been paused, revoked or deleted.
 */
import { admin, type Db } from '../db'
import { audit } from '../engine/audit'
import type { CompetitorPolicy } from '../agents/policy'
import { collectStore } from './collect'
import { compareStore, crossStore, type Finding, type StoredProduct, type StoreProducts } from './compare'
import { PoliteFetcher, competitorFetchOverridden } from './fetch'
import { isSyntheticHost, syntheticAllowed, syntheticTransport } from './synthetic'

export type CompetitorRunCounts = { storesChecked: number; storesSkipped: number; baselines: number; productsSeen: number; findings: number; opportunities: number }

type SourceRow = { id: string; url: string; host: string; status: string; checks_done: number; baseline_at: string | null }
type ProductRow = {
  product_key: string; title: string; url: string; product_type: string | null; vendor: string | null; tags: string[]; price: string | null; compare_at: string | null; available: boolean | null
  published_at: string | null; bestseller_list: string | null; bestseller_position: number | null; featured_in: string[]; listed: boolean; first_seen_at: string; last_seen_at: string
}
const toStored = (r: ProductRow): StoredProduct => ({ key: r.product_key, title: r.title, url: r.url, productType: r.product_type, vendor: r.vendor, tags: r.tags, price: r.price === null ? null : Number(r.price),
  compareAt: r.compare_at === null ? null : Number(r.compare_at), available: r.available, publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
  bestsellerList: r.bestseller_list, bestsellerPosition: r.bestseller_position, featuredIn: r.featured_in, listed: r.listed,
  firstSeenAt: new Date(r.first_seen_at).toISOString(), lastSeenAt: new Date(r.last_seen_at).toISOString() })

async function insertFindings(db: Db, orgId: string, agentId: string, runId: string, findings: Finding[]): Promise<number> {
  let n = 0
  for (const f of findings) {
    // a starting point is a record, not an alert: it is stored as already seen
    const r = await db.one<{ id: string }>(`insert into competitor_findings (org_id, agent_id, source_id, run_id, kind, basis, title, summary, product_key, evidence, dedupe_key, status)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (agent_id, dedupe_key) do nothing returning id`,
      [orgId, agentId, f.sourceId, runId, f.kind, f.basis, f.title.slice(0, 300), f.summary.slice(0, 2000), f.productKey, JSON.stringify(f.evidence), f.dedupeKey.slice(0, 400), f.kind === 'baseline' ? 'seen' : 'new'])
    if (r) n++
  }
  return n
}

function fetcherFor(host: string, step: number): PoliteFetcher | 'blocked' {
  if (competitorFetchOverridden()) return new PoliteFetcher()
  if (isSyntheticHost(host)) return syntheticAllowed() ? new PoliteFetcher(syntheticTransport(step)) : 'blocked'
  return new PoliteFetcher()
}

export async function runCompetitorStep(input: {
  agentId: string; orgId: string; connectionId: string; runId: string; policyVersion: number; policy: CompetitorPolicy
  /** your own product names, to tell a possible opportunity from something you already sell; null = not compared */
  ownTitles: string[] | null; actor: string; now: Date
}): Promise<CompetitorRunCounts> {
  const { agentId, orgId, policy: c } = input
  const counts: CompetitorRunCounts = { storesChecked: 0, storesSkipped: 0, baselines: 0, productsSeen: 0, findings: 0, opportunities: 0 }
  const sources = await admin(async db => {
    for (const st of c.stores) {
      const host = new URL(st.url).hostname
      await db.query(`insert into competitor_sources (org_id, agent_id, url, host) values ($1,$2,$3,$4) on conflict (agent_id, host) do update set url = excluded.url`, [orgId, agentId, st.url, host])
    }
    return db.query<SourceRow>(`select id, url, host, status, checks_done, baseline_at from competitor_sources where agent_id = $1 and host = any($2::text[]) order by created_at`,
      [agentId, c.stores.map(st => new URL(st.url).hostname)])
  })

  const across: StoreProducts[] = []
  for (const src of sources) {
    const still = await admin(db => db.one<{ status: string }>('select status from agents where id = $1', [agentId]))
    if (still?.status !== 'active') break
    const started = new Date()
    const f = fetcherFor(src.host, src.checks_done)
    const result = f === 'blocked'
      ? { status: 'unreachable' as const, platform: 'unknown' as const, reason: 'synthetic demo stores are not available here', requests: 0, urls: [] as string[] }
      : await collectStore(src.url, { fetcher: f, now: input.now })
    if (result.status !== 'ok') {
      counts.storesSkipped++
      await admin(async db => {
        await db.query(`update competitor_sources set status = $2, platform = case when $3 = 'unknown' then platform else $3 end, status_reason = $4, last_checked_at = $5 where id = $1`,
          [src.id, result.status, result.platform, result.reason, input.now.toISOString()])
        await db.query(`insert into competitor_checks (org_id, agent_id, source_id, run_id, status, status_reason, requests, urls, started_at, finished_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
          [orgId, agentId, src.id, input.runId, result.status, result.reason, result.requests, result.urls.slice(0, 20), started.toISOString()])
        await audit(db, { orgId, connectionId: input.connectionId, entityType: 'agent', entityId: agentId, event: 'competitor.skipped', actor: input.actor,
          detail: { agent_id: agentId, policy_version: input.policyVersion, store: src.host, url: src.url, status: result.status, reason: result.reason, requests: result.requests } })
      })
      continue
    }
    const snap = result.snapshot
    await admin(async db => {
      const prevRows = await db.query<ProductRow>('select * from competitor_products where source_id = $1', [src.id])
      const lastOk = src.baseline_at ? await db.one<{ started_at: string }>(`select started_at from competitor_checks where source_id = $1 and status in ('baseline','compared') order by started_at desc limit 1`, [src.id]) : null
      const prevObservedAt = src.baseline_at ? new Date(lastOk?.started_at ?? src.baseline_at).toISOString() : null
      const cmp = compareStore({ sourceId: src.id, host: src.host, prev: new Map(prevRows.map(r => [r.product_key, toStored(r)])), prevObservedAt, snapshot: snap, prefs: c })
      for (const p of cmp.next) {
        await db.query(`insert into competitor_products (org_id, agent_id, source_id, product_key, title, url, product_type, vendor, tags, price, compare_at, available, published_at, bestseller_list, bestseller_position, featured_in, listed, first_seen_at, last_seen_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
          on conflict (source_id, product_key) do update set title = excluded.title, url = excluded.url, product_type = excluded.product_type, vendor = excluded.vendor, tags = excluded.tags,
            price = excluded.price, compare_at = excluded.compare_at, available = excluded.available, published_at = excluded.published_at, bestseller_list = excluded.bestseller_list,
            bestseller_position = excluded.bestseller_position, featured_in = excluded.featured_in, listed = excluded.listed, last_seen_at = excluded.last_seen_at`,
          [orgId, agentId, src.id, p.key, p.title, p.url, p.productType, p.vendor, p.tags, p.price, p.compareAt, p.available, p.publishedAt, p.bestsellerList, p.bestsellerPosition, p.featuredIn, p.listed, p.firstSeenAt, p.lastSeenAt])
      }
      const added = await insertFindings(db, orgId, agentId, input.runId, cmp.findings)
      const kind = prevObservedAt ? 'compared' : 'baseline'
      await db.query(`update competitor_sources set status = 'active', platform = 'shopify', status_reason = null, checks_done = checks_done + 1, baseline_at = coalesce(baseline_at, $2), last_checked_at = $2 where id = $1`, [src.id, snap.observedAt])
      await db.query(`insert into competitor_checks (org_id, agent_id, source_id, run_id, status, requests, products_seen, urls, started_at, finished_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
        [orgId, agentId, src.id, input.runId, kind, result.requests, cmp.next.filter(p => p.listed).length, snap.urls.slice(0, 20), snap.observedAt])
      await audit(db, { orgId, connectionId: input.connectionId, entityType: 'agent', entityId: agentId, event: kind === 'baseline' ? 'competitor.baseline' : 'competitor.checked', actor: input.actor,
        detail: { agent_id: agentId, policy_version: input.policyVersion, store: src.host, url: src.url, products_seen: cmp.next.filter(p => p.listed).length, requests: result.requests, findings: added,
          reason: kind === 'baseline' ? 'first check: starting point recorded; nothing is reported as new' : `${added} new finding(s) compared with the previous check` } })
      counts.storesChecked++
      counts.productsSeen += cmp.next.filter(p => p.listed).length
      counts.findings += added
      if (kind === 'baseline') counts.baselines++
      across.push({ sourceId: src.id, host: src.host, products: cmp.next, newKeys: cmp.newKeys, observedAt: snap.observedAt })
    })
  }

  // across stores: only what was read in this run, so every inference rests on current observations
  if (across.length >= 2) {
    const trends = crossStore(across, { ownTitles: c.compareOwnCatalog ? input.ownTitles : null, alerts: c.alerts, observedAt: input.now.toISOString() })
    if (trends.length) {
      const added = await admin(async db => {
        const n = await insertFindings(db, orgId, agentId, input.runId, trends)
        if (n) await audit(db, { orgId, connectionId: input.connectionId, entityType: 'agent', entityId: agentId, event: 'competitor.trends', actor: input.actor,
          detail: { agent_id: agentId, policy_version: input.policyVersion, findings: n, reason: 'similar products found on several monitored stores (inference from public listings)' } })
        return n
      })
      counts.findings += added
      counts.opportunities = (await admin(db => db.one<{ n: number }>(`select count(*)::int as n from competitor_findings where run_id = $1 and kind = 'opportunity'`, [input.runId])))!.n
    }
  }
  return counts
}
