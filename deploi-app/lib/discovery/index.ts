/**
 * Business Discovery: connect an app → Deploi reads what it is authorized to read → findings become
 * `detected` cases → a recommended AI team → the owner creates it in one click (drafts only) and grants
 * what was shown → agents start working. The organization always comes from the signed-in actor.
 *
 * Owner calls from a fresh connection to a working monitoring agent (discovery itself is queued by the
 * connection, so the first call is optional):
 *   1. POST /api/store/discover            run discovery now (optional when the connection queued it)
 *   2. POST /api/store/discover/team       create the recommended team at drafts only -> summaries + hashes
 *   3. POST /api/store/discover/team       { op: 'grant', grants: [{ agentId, policyHash }] } for every shown policy
 */
import { admin } from '../db'
import { assertMerchant, withActor, type Actor } from '../engine/actor'
import { EngineError } from '../engine/errors'
import type { CaseStatus, Priority } from '../cases'
import { runDiscovery, type DiscoveryRunRow } from './run'
import { agentState, createTeam, grantTeam, templateSetup, type GrantRequest, type TeamAgentState, type TeamRecommendation } from './team'
import type { BusinessProfile } from './profile'

export { runDiscovery } from './run'
export { requestDiscovery } from './jobs'
export { aggregateRecommendations, registerTemplateSetup } from './team'

type MerchantActor = Exclude<Actor, { kind: 'staff' }>
function merchant(actor: Actor): MerchantActor {
  if (actor.kind === 'staff') throw new EngineError('forbidden', "discovery belongs to a customer's organization; Deploi staff cannot run or view it here")
  assertMerchant(actor, actor.orgId)
  return actor
}

export type DiscoverCase = { id: string; ref: string; kind: string; title: string; problem: string; priority: Priority; status: CaseStatus; sourceApp: string; openedAt: string }
export type DiscoverTeamItem = TeamRecommendation & { agent: TeamAgentState | null }
export type DiscoverView = {
  running: boolean
  run: Pick<DiscoveryRunRow, 'id' | 'status' | 'status_reason' | 'trigger' | 'source' | 'started_at' | 'finished_at' | 'sources' | 'detectors' | 'findings_count' | 'cases_opened'> | null
  profile: (BusinessProfile & { runId: string | null }) | null
  findings: { total: number; open: number; byKind: { kind: string; count: number }[]; cases: DiscoverCase[] }
  team: DiscoverTeamItem[]
  connected: boolean
}

const RUN_COLS = 'id, status, status_reason, trigger, source, started_at, finished_at, sources, detectors, findings_count, cases_opened, case_ids, recommendations'
const PRIORITY_ORDER = `case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`

export async function discoverView(actor: Actor): Promise<DiscoverView> {
  const m = merchant(actor)
  return withActor(m, async db => {
    const latest = await db.one<DiscoveryRunRow>(`select ${RUN_COLS} from discovery_runs where org_id = $1 order by started_at desc limit 1`, [m.orgId])
    const done = latest && latest.status !== 'running' && latest.status !== 'failed' ? latest
      : await db.one<DiscoveryRunRow>(`select ${RUN_COLS} from discovery_runs where org_id = $1 and status in ('completed','partial') order by started_at desc limit 1`, [m.orgId])
    const p = await db.one<{ run_id: string | null; profile: BusinessProfile }>('select run_id, profile from business_profiles where org_id = $1', [m.orgId])
    const ids = done?.case_ids ?? []
    const cases = ids.length ? await db.query<{ id: string; ref: string; kind: string; title: string; problem: string; priority: Priority; status: CaseStatus; source_app: string; opened_at: string }>(
      `select id, ref, kind, title, problem, priority, status, source_app, opened_at from cases where org_id = $1 and id = any($2::uuid[]) order by (status in ('resolved','cancelled')), ${PRIORITY_ORDER}, opened_at`, [m.orgId, ids]) : []
    const byKind = new Map<string, number>()
    for (const c of cases) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1)
    const links = await db.query<{ template: string; agent_kind: 'engine' | 'office'; agent_id: string | null }>('select template, agent_kind, agent_id from discovery_agents where org_id = $1', [m.orgId])
    const team: DiscoverTeamItem[] = []
    for (const rec of done?.recommendations ?? []) {
      const l = links.find(x => x.template === rec.template && x.agent_id)
      team.push({ ...rec, setup: templateSetup(rec.template) ? 'automatic' : 'manual', agent: l ? await agentState(db, m.orgId, l.agent_kind, l.agent_id!) : null })
    }
    const conn = await db.one<{ n: number }>(`select ((select count(*) from store_connections where org_id = $1 and status = 'active') + (select count(*) from office_connections where org_id = $1 and status = 'active')
      + (select count(*) from email_accounts where org_id = $1 and status = 'active'))::int as n`, [m.orgId])
    const { case_ids: _ids, recommendations: _recs, ...run } = latest ?? ({} as DiscoveryRunRow)
    void _ids; void _recs
    return {
      running: latest?.status === 'running',
      run: latest ? run : null,
      profile: p ? { ...p.profile, runId: p.run_id } : null,
      findings: {
        total: cases.length, open: cases.filter(c => c.status !== 'resolved' && c.status !== 'cancelled').length,
        byKind: [...byKind.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
        cases: cases.slice(0, 50).map(c => ({ id: c.id, ref: c.ref, kind: c.kind, title: c.title, problem: c.problem, priority: c.priority, status: c.status, sourceApp: c.source_app, openedAt: c.opened_at })),
      },
      team,
      connected: (conn?.n ?? 0) > 0,
    }
  })
}

/** Run discovery now for the actor's organization (the owner's "discover" button). */
export async function discoverNow(actor: Actor) {
  const m = merchant(actor)
  return runDiscovery(m.orgId, { trigger: 'manual', source: 'owner', actor: m.label })
}

async function latestRecommendations(orgId: string): Promise<TeamRecommendation[]> {
  const r = await admin(db => db.one<{ recommendations: TeamRecommendation[] }>(`select recommendations from discovery_runs where org_id = $1 and status in ('completed','partial') order by started_at desc limit 1`, [orgId]))
  if (!r) throw new EngineError('invalid_input', 'run discovery first: there is no recommended team yet')
  return r.recommendations ?? []
}

/** One-click setup of the latest recommended team (or the templates named in `only`), at drafts only. */
export async function setUpTeam(actor: Actor, opts: { only?: string[] } = {}) {
  const m = merchant(actor)
  const recs = await latestRecommendations(m.orgId)
  const chosen = opts.only?.length ? recs.filter(r => opts.only!.includes(r.template)) : recs
  return createTeam(m, chosen)
}

export async function grantShownTeam(actor: Actor, grants: GrantRequest[]) {
  return grantTeam(merchant(actor), grants)
}
