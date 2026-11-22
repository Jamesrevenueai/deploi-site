/**
 * Discovery runs. runDiscovery(orgId) runs every registered detector whose connection is present and
 * readable, turns findings into `detected` cases (openCase: one open case per problem, so a re-run adds
 * evidence instead of a second case), builds the business profile from authorized data only, and records
 * what was read, what was not and why, and the recommended team. One run at a time per organization.
 * A detector that fails or does not answer in time is recorded as such; the run is then `partial`.
 */
import { admin } from '../db'
import { audit } from '../engine/audit'
import { openCase, registeredCaseKinds } from '../cases'
import { listDetectors, type Detector, type DetectorContext, type ProfileFact } from './registry'
import { buildProfile, type BusinessProfile, type SourceRecord } from './profile'
import { aggregateRecommendations, type RecommendationInput, type TeamRecommendation } from './team'
import { DiscoveryTimeout, withTimeout } from './timeout'
import './detectors'

export type DiscoveryTrigger = 'manual' | 'connection' | 'schedule' | 'test'
export type DetectorOutcome = {
  key: string; suite: string; sourceApp: string
  status: 'ok' | 'not_available' | 'failed' | 'timeout'
  findings: number; casesOpened: number; casesExisting: number; casesFailed: number
  sourcesRead: string[]; notes: string[]; ms: number
}
export type DiscoveryRunRow = {
  id: string; org_id: string; trigger: DiscoveryTrigger; source: string | null; status: 'running' | 'completed' | 'partial' | 'failed'; status_reason: string | null
  sources: SourceRecord[]; detectors: DetectorOutcome[]; case_ids: string[]; findings_count: number; cases_opened: number
  recommendations: TeamRecommendation[]; created_by: string; started_at: string; finished_at: string | null
}

export const discoveryConfig = {
  get detectorTimeoutMs() { const v = Number(process.env.DISCOVERY_DETECTOR_TIMEOUT_MS); return Number.isFinite(v) && v > 0 ? v : 25_000 },
  /** a run still marked running after this long was interrupted (the worker stopped) */
  staleRunMs: 10 * 60_000,
  /** a case whose kind has a checker is looked at again after this long */
  recheckMs: 24 * 3600e3,
}

const ACTOR = 'system:discovery'
const clip = (s: string, n: number) => s.slice(0, n)

async function startRun(orgId: string, trigger: DiscoveryTrigger, source: string | null, actor: string): Promise<{ run: DiscoveryRunRow; started: boolean }> {
  return admin(async db => {
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [`discovery:${orgId}`])
    const running = await db.one<DiscoveryRunRow>(`select * from discovery_runs where org_id = $1 and status = 'running'`, [orgId])
    if (running) {
      if (Date.now() - new Date(running.started_at).getTime() < discoveryConfig.staleRunMs) return { run: running, started: false }
      await db.query(`update discovery_runs set status = 'failed', status_reason = 'interrupted: the run stopped before it finished', finished_at = now() where id = $1`, [running.id])
    }
    const run = (await db.one<DiscoveryRunRow>(`insert into discovery_runs (org_id, trigger, source, created_by) values ($1,$2,$3,$4) returning *`, [orgId, trigger, source ? clip(source, 200) : null, clip(actor, 160)]))!
    return { run, started: true }
  })
}

async function runDetector(d: Detector, ctx: DetectorContext, timeoutMs: number, caseIds: string[], recs: RecommendationInput[], facts: ProfileFact[]): Promise<DetectorOutcome> {
  const t0 = Date.now()
  const out: DetectorOutcome = { key: d.key, suite: d.suite, sourceApp: d.sourceApp, status: 'ok', findings: 0, casesOpened: 0, casesExisting: 0, casesFailed: 0, sourcesRead: [], notes: [], ms: 0 }
  try {
    const available = await withTimeout(admin(db => d.available(db, ctx.orgId)), Math.min(timeoutMs, 10_000))
    if (!available) { out.status = 'not_available'; out.notes.push('nothing this detector reads is connected'); return out }
    const r = await withTimeout(d.detect({ ...ctx, deadline: Date.now() + timeoutMs }), timeoutMs)
    out.sourcesRead = [...new Set(r.sourcesRead ?? [])]
    out.notes = (r.notes ?? []).map(n => clip(String(n), 300))
    out.findings = r.findings.length
    const checked = new Set(registeredCaseKinds())
    for (const f of r.findings) {
      try {
        const res = await admin(db => openCase(db, {
          orgId: ctx.orgId, suite: d.suite, kind: f.kind, sourceApp: f.sourceApp ?? d.sourceApp, dedupeKey: f.dedupeKey, title: f.title, problem: f.problem,
          whyItMatters: f.whyItMatters ?? null, priority: f.priority, evidence: f.evidence, records: f.records, verification: f.verification, actor: `${ACTOR}:${d.key}`,
          nextCheckAt: checked.has(f.kind) ? new Date(ctx.now.getTime() + discoveryConfig.recheckMs) : null,
        }))
        caseIds.push(res.case.id)
        if (res.created) out.casesOpened++; else out.casesExisting++
      } catch (e) {
        out.casesFailed++
        if (out.notes.length < 20) out.notes.push(clip(`a finding could not be recorded: ${(e as Error).message}`, 300))
      }
    }
    if (out.casesFailed) out.status = 'failed'
    for (const rec of [r.recommendation, ...(r.recommendations ?? [])]) if (rec) recs.push({ rec, findings: r.findings.length, detector: d.key })
    facts.push(...(r.facts ?? []))
  } catch (e) {
    out.status = e instanceof DiscoveryTimeout ? 'timeout' : 'failed'
    out.notes.push(clip(e instanceof DiscoveryTimeout ? `did not finish within ${Math.round(timeoutMs / 1000)} s; results not recorded` : `failed: ${(e as Error).message}`, 300))
  } finally {
    out.ms = Date.now() - t0
  }
  return out
}

export type RunOptions = { trigger?: DiscoveryTrigger; source?: string | null; actor?: string; now?: Date; detectorTimeoutMs?: number; detectors?: Detector[] }

/** Run discovery for one organization. Returns the existing run when one is already in progress. */
export async function runDiscovery(orgId: string, opts: RunOptions = {}): Promise<{ run: DiscoveryRunRow; started: boolean }> {
  const actor = opts.actor ?? ACTOR
  const { run, started } = await startRun(orgId, opts.trigger ?? 'manual', opts.source ?? null, actor)
  if (!started) return { run, started }
  const timeoutMs = opts.detectorTimeoutMs ?? discoveryConfig.detectorTimeoutMs
  const ctx: DetectorContext = { orgId, now: opts.now ?? new Date(), shared: new Map() }
  try {
    const detectors = [...(opts.detectors ?? listDetectors())].sort((a, b) => a.key.localeCompare(b.key))
    const caseIds: string[] = [], recs: RecommendationInput[] = [], facts: ProfileFact[] = []
    const outcomes = await Promise.all(detectors.map(d => runDetector(d, ctx, timeoutMs, caseIds, recs, facts)))
    let built: { profile: BusinessProfile; sources: SourceRecord[] }
    try { built = await buildProfile(ctx, { timeoutMs }) } catch (e) {
      built = { profile: { builtAt: new Date().toISOString(), platforms: [], facts: [], notRead: [{ app: 'deploi', label: 'Profile', reason: `Profile not built: ${(e as Error).message.slice(0, 160)}` }] }, sources: [] }
    }
    built.profile.facts.push(...facts.filter(f => f && typeof f.key === 'string' && f.source && f.observedAt))
    const recommendations = aggregateRecommendations(recs)
    const ids = [...new Set(caseIds)]
    // partial: a detector failed or timed out, or a connected source could not be read (needs reauth, error, timeout)
    const partial = outcomes.some(o => o.status === 'failed' || o.status === 'timeout') || built.sources.some(s => s.status !== 'read')
    const reasons = [...outcomes.filter(o => o.status === 'failed' || o.status === 'timeout').map(o => `${o.key}: ${o.status}`), ...built.sources.filter(s => s.status !== 'read' && s.reason).map(s => `${s.label} not read: ${s.reason}`)]
    const done = (await admin(async db => {
      const r = await db.one<DiscoveryRunRow>(
        `update discovery_runs set status = $2, status_reason = $3, sources = $4, detectors = $5, case_ids = $6, findings_count = $7, cases_opened = $8, recommendations = $9, finished_at = now() where id = $1 returning *`,
        [run.id, partial ? 'partial' : 'completed', reasons.length ? clip(reasons.join('; '), 1000) : null, JSON.stringify(built.sources), JSON.stringify(outcomes), ids,
          outcomes.reduce((n, o) => n + o.findings, 0), outcomes.reduce((n, o) => n + o.casesOpened, 0), JSON.stringify(recommendations)])
      await db.query(`insert into business_profiles (org_id, run_id, profile, built_at) values ($1,$2,$3,now())
        on conflict (org_id) do update set run_id = excluded.run_id, profile = excluded.profile, built_at = excluded.built_at`, [orgId, run.id, JSON.stringify(built.profile)])
      await audit(db, { orgId, entityType: 'org', entityId: orgId, event: 'discovery.completed', actor, detail: { run_id: run.id, trigger: run.trigger, status: r!.status, findings: r!.findings_count, cases_opened: r!.cases_opened, recommended: recommendations.map(x => x.template) } })
      return r
    }))!
    return { run: done, started: true }
  } catch (e) {
    await admin(db => db.query(`update discovery_runs set status = 'failed', status_reason = $2, finished_at = now() where id = $1 and status = 'running'`, [run.id, clip((e as Error).message, 1000)]))
    throw e
  }
}
