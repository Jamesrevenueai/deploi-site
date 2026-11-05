/**
 * Case adapter for the Competitor & Trend Watcher. Its findings are information, not problems: each new
 * finding (never a baseline) is one `market_signal` case, opened with its public evidence. Nothing in it can
 * be fixed or verified, so it is never resolved: the owner acknowledging it (here, or by marking the finding
 * seen) closes it as `cancelled` with the reason "acknowledged"; dismissing the finding closes it the same way.
 */
import { admin, type Db } from '../db'
import { log } from '../log'
import { caseForRecord, openCase, TERMINAL, transitionCase, type CaseRow } from '../cases'
import { registerCaseClose } from '../cases/close'
import type { Evidence as FindingEvidence } from './compare'

export const MARKET_SIGNAL_KIND = 'market_signal'
const ACTOR = 'system:competitor-watcher'
export const ACKNOWLEDGED = 'acknowledged'

type FindingRow = { id: string; org_id: string; agent_id: string; kind: string; basis: string; title: string; summary: string; evidence: FindingEvidence[]; status: string; created_at: string; host: string | null }

/** One case per new finding of the run (idempotent: a finding with a case is skipped). */
export async function syncCompetitorCases(agentId: string, opts: { runId?: string } = {}): Promise<number> {
  const rows = await admin(db => db.query<FindingRow>(
    `select f.id, f.org_id, f.agent_id, f.kind, f.basis, f.title, f.summary, f.evidence, f.status, f.created_at, s.host from competitor_findings f left join competitor_sources s on s.id = f.source_id
     where f.agent_id = $1 and f.kind <> 'baseline' and f.status = 'new' and ($2::uuid is null or f.run_id = $2)
       and not exists (select 1 from case_links l where l.ref_type = 'competitor_finding' and l.ref_id = f.id::text) order by f.created_at limit 500`, [agentId, opts.runId ?? null]))
  let n = 0
  for (const f of rows) {
    try {
      await admin(db => openCase(db, {
        orgId: f.org_id, suite: 'commerce', kind: MARKET_SIGNAL_KIND, sourceApp: 'public_web', dedupeKey: `market_signal:${f.id}`,
        title: f.title.slice(0, 300).padEnd(3, '.'), problem: `${f.summary}${f.basis === 'inference' ? '\n\nThis is Deploi\'s reading of several public observations, not a fact.' : ''}`.slice(0, 4000),
        whyItMatters: 'For your information: what competitors show publicly. Nothing needs fixing and nothing is changed.', priority: 'low',
        agent: { kind: 'engine', ref: f.agent_id },
        evidence: (Array.isArray(f.evidence) ? f.evidence : []).slice(0, 10).map(e => ({ label: `${e.what}${e.store ? ` (${e.store})` : ''}`.slice(0, 300) || f.title.slice(0, 300), source: 'public_web', observedAt: e.observedAt ?? f.created_at, detail: { url: e.url, before: e.before ?? null, after: e.after ?? null, basis: f.basis } })),
        records: [{ type: 'competitor_finding', id: f.id, label: f.host ?? 'Competitor finding' }],
        verification: { criteria: 'Informational: closed when you acknowledge it. It is never marked resolved, because there is nothing to fix or verify.' },
        nextAction: 'Read it, then acknowledge it.', actor: ACTOR,
      }))
      n++
    } catch (e) { log.error('competitor.case_open_failed', { finding_id: f.id, error: (e as Error).message }) }
  }
  return n
}

/** Findings marked seen or dismissed close their cases (acknowledged, or dismissed by the owner). */
export async function closeFindingCases(db: Db, orgId: string, findingIds: string[], how: 'seen' | 'dismissed', actor: string) {
  for (const id of findingIds) {
    const c = await caseForRecord(db, orgId, 'competitor_finding', id)
    if (!c || TERMINAL.includes(c.status)) continue
    await transitionCase(db, c.id, { to: 'cancelled', actor, reason: how === 'seen' ? ACKNOWLEDGED : 'dismissed by you', nextCheckAt: null, nextAction: null })
  }
}

registerCaseClose(MARKET_SIGNAL_KIND, {
  label: 'Acknowledge', needsReason: false, fixedReason: ACKNOWLEDGED,
  async onClose(db: Db, c: CaseRow) {
    const ids = (await db.query<{ ref_id: string }>(`select ref_id from case_links where case_id = $1 and ref_type = 'competitor_finding'`, [c.id])).map(r => r.ref_id)
    if (ids.length) await db.query(`update competitor_findings set status = 'seen' where org_id = $1 and id = any($2::uuid[]) and status = 'new'`, [c.org_id, ids])
  },
})
