/**
 * What the merchant sees of a competitor watcher: the monitored stores with their status, findings
 * with their evidence, and recent checks. Read under the caller's RLS, so another organization gets
 * "not found". Marking findings seen or dismissing them is for the organization's own members only.
 */
import { admin } from '../db'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import type { Evidence, FindingKind } from './compare'

export type CompetitorSourceView = { id: string; url: string; host: string; platform: string; status: string; status_reason: string | null; checks_done: number; baseline_at: string | null; last_checked_at: string | null; products: number }
export type CompetitorFindingView = { id: string; kind: FindingKind; basis: 'observed' | 'inference'; title: string; summary: string; evidence: Evidence[]; status: 'new' | 'seen' | 'dismissed'; created_at: string; host: string | null }
export type CompetitorCheckView = { id: string; host: string; status: string; status_reason: string | null; requests: number; products_seen: number; urls: string[]; started_at: string }

export async function competitorView(actor: Actor, agentId: string, opts: { limit?: number } = {}): Promise<{ sources: CompetitorSourceView[]; findings: CompetitorFindingView[]; checks: CompetitorCheckView[]; unseen: number }> {
  return withActor(actor, async db => {
    const agent = await db.one<{ id: string }>('select id from agents where id = $1', [agentId])
    if (!agent) throw new EngineError('not_found', 'agent not found')
    const sources = await db.query<CompetitorSourceView>(
      `select s.id, s.url, s.host, s.platform, s.status, s.status_reason, s.checks_done, s.baseline_at, s.last_checked_at,
         (select count(*)::int from competitor_products p where p.source_id = s.id and p.listed) as products
       from competitor_sources s where s.agent_id = $1 order by s.created_at`, [agentId])
    const findings = await db.query<CompetitorFindingView>(
      `select f.id, f.kind, f.basis, f.title, f.summary, f.evidence, f.status, f.created_at, s.host from competitor_findings f left join competitor_sources s on s.id = f.source_id
       where f.agent_id = $1 and f.status <> 'dismissed' order by f.created_at desc, f.basis desc limit $2`, [agentId, Math.min(opts.limit ?? 200, 500)])
    const checks = await db.query<CompetitorCheckView>(
      `select c.id, s.host, c.status, c.status_reason, c.requests, c.products_seen, c.urls, c.started_at from competitor_checks c join competitor_sources s on s.id = c.source_id
       where c.agent_id = $1 order by c.started_at desc limit 30`, [agentId])
    const unseen = await db.one<{ n: number }>(`select count(*)::int as n from competitor_findings where agent_id = $1 and status = 'new' and kind <> 'baseline'`, [agentId])
    return { sources, findings, checks, unseen: unseen?.n ?? 0 }
  })
}

/** Mark findings as seen (all of this agent's new ones, or the ids given), or dismiss them. */
export async function setFindingsStatus(actor: Actor, agentId: string, status: 'seen' | 'dismissed', ids: string[] | null): Promise<number> {
  const a = await withActor(actor, db => db.one<{ id: string; org_id: string }>('select id, org_id from agents where id = $1', [agentId]))
  if (!a) throw new EngineError('not_found', 'agent not found')
  assertMerchant(actor, a.org_id)
  return admin(async db => {
    const rows = ids
      ? await db.query<{ id: string }>(`update competitor_findings set status = $3 where agent_id = $1 and id = any($2::uuid[]) and status <> 'dismissed' returning id`, [agentId, ids, status])
      : await db.query<{ id: string }>(`update competitor_findings set status = $2 where agent_id = $1 and status = 'new' returning id`, [agentId, status])
    return rows.length
  })
}
