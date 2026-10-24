/**
 * Client dashboard sections beyond the six tiles. Every optional table (engagements, pilots, imports,
 * proposed_actions.simulated) is guarded and degrades to a visible "not available yet" state. Runs as the
 * signed-in client user; reads of client-side data are audited.
 */
import type { Db } from '../db'
import { getService, AVAILABILITY_LABEL, type ServiceDef } from '../catalog/services'
import { tableExists, columnExists, tableColumns, str, numOrNull, NOT_AVAILABLE } from './optional'
import { rankActionItems, type ActionItem, type RankedActionItem } from './urgency'
import type { Metrics } from './metrics'

export const STALE_AFTER_DAYS = 7
export const OUTCOME_WINDOW_DAYS = 30
export const CSV_NOTE = 'CSV-based: data is as fresh as your last export.'

export type ActiveService = { key: string; name: string; status: string; availability: string; availabilityLabel: string }
export type ImportFreshness = { kind: string; lastAt: string | null; ageDays: number | null; stale: boolean; source: 'evv_imports' | 'imports' }
export type Freshness = { imports: ImportFreshness[]; importsNote: string | null; lastWorkerRun: { worker: string; finishedAt: string } | null; anyStale: boolean }
export type VerifiedActivity = { available: boolean; note: string | null; delivered: number; byWorker: { worker: string; n: number }[]; windowDays: number }
export type VerifiedOutcomes = { windowDays: number; shiftsFilled: number; referralsAnswered: number; exceptionsCorrected: number; whatCounts: string[] }
export type PilotProgress = { available: boolean; note: string | null; startsOn: string | null; endsOn: string | null; metricKey: string | null; metricLabel: string | null; baseline: number | null; latest: number | null; decision: string | null; status: string | null }
export type Limitation = { service: string; exclusions: string[]; volumeLimits: string[] }

export type ClientSections = {
  services: { rows: ActiveService[]; note: string | null }
  freshness: Freshness
  activity: VerifiedActivity
  outcomes: VerifiedOutcomes
  actionItems: { items: RankedActionItem[]; pendingApprovals: number }
  pilot: PilotProgress
  limitations: { rows: Limitation[]; csvNote: string }
}

const ACTIVE_STATUSES = new Set(['accepted', 'building', 'testing', 'pilot', 'active', 'paused'])
const ageDays = (iso: string | null, now: Date) => (iso ? Math.floor((now.getTime() - new Date(iso).getTime()) / 86400e3) : null)

export async function getClientSections(db: Db, agencyId: string, metrics: Metrics, now = new Date()): Promise<ClientSections> {
  const since = new Date(now.getTime() - OUTCOME_WINDOW_DAYS * 86400e3)

  // ---- active services (engage stream's table)
  let services: ActiveService[] = []
  let servicesNote: string | null = null
  if (await tableExists(db, 'engagements')) {
    const rows = await db.query<{ row: Record<string, unknown> }>('select to_jsonb(e) as row from engagements e where e.agency_id = $1 order by e.created_at', [agencyId])
    services = rows.map(({ row }) => ({ key: str(row, 'service_key') ?? '', status: str(row, 'status') ?? 'unknown' }))
      .filter(r => ACTIVE_STATUSES.has(r.status))
      .map(r => { const s = getService(r.key); return { key: r.key, name: s?.name ?? r.key, status: r.status, availability: s?.availability ?? 'planned', availabilityLabel: s ? AVAILABILITY_LABEL[s.availability] : 'Unknown service' } })
    if (!services.length) servicesNote = 'No active services recorded yet.'
  } else {
    servicesNote = 'No active services recorded yet.'
  }

  // ---- reporting period and data freshness
  const imports: ImportFreshness[] = []
  const evv = await db.query<{ source: string; last: string | null }>(
    "select source, max(committed_at)::text as last from evv_imports where agency_id = $1 and status = 'committed' group by source", [agencyId])
  await db.auditRead('evv_imports', agencyId)
  for (const r of evv) { const a = ageDays(r.last, now); imports.push({ kind: `EVV visits (${r.source})`, lastAt: r.last, ageDays: a, stale: a === null || a > STALE_AFTER_DAYS, source: 'evv_imports' }) }
  let importsNote: string | null = null
  if (await tableExists(db, 'imports')) {
    const cols = await tableColumns(db, 'imports')
    if (cols.has('agency_id')) {
      const rows = await db.query<{ row: Record<string, unknown> }>('select to_jsonb(i) as row from imports i where i.agency_id = $1 order by i.created_at desc limit 50', [agencyId])
      await db.auditRead('imports', agencyId)
      const seen = new Map<string, string | null>()
      for (const { row } of rows) {
        const status = str(row, 'status')
        if (status && !['committed', 'done', 'succeeded', 'success', 'complete', 'completed'].includes(status)) continue
        const kind = str(row, 'kind') ?? str(row, 'source') ?? 'import'
        const at = str(row, 'committed_at') ?? str(row, 'finished_at') ?? str(row, 'created_at')
        if (!seen.has(kind) || (at && (seen.get(kind) ?? '') < at)) seen.set(kind, at)
      }
      for (const [kind, at] of seen) { const a = ageDays(at, now); imports.push({ kind, lastAt: at, ageDays: a, stale: a === null || a > STALE_AFTER_DAYS, source: 'imports' }) }
    }
  } else {
    importsNote = `Other import kinds ${NOT_AVAILABLE}.`
  }
  const run = await db.one<{ worker: string; finished_at: string }>('select worker, finished_at::text from agency_last_worker_run($1)', [agencyId])
  const freshness: Freshness = { imports, importsNote, lastWorkerRun: run ? { worker: run.worker, finishedAt: run.finished_at } : null, anyStale: imports.length === 0 || imports.some(i => i.stale) }

  // ---- verified activity: delivered, non-simulated actions only
  const hasSimulated = await columnExists(db, 'proposed_actions', 'simulated')
  let activity: VerifiedActivity
  if (hasSimulated) {
    const rows = await db.query<{ worker: string; n: string }>(
      "select worker, count(*)::text as n from proposed_actions where agency_id = $1 and status = 'delivered' and simulated = false and coalesce(sent_at, created_at) >= $2 group by worker order by worker", [agencyId, since])
    await db.auditRead('proposed_actions', agencyId)
    const byWorker = rows.map(r => ({ worker: r.worker, n: Number(r.n) }))
    activity = { available: true, note: null, delivered: byWorker.reduce((a, b) => a + b.n, 0), byWorker, windowDays: OUTCOME_WINDOW_DAYS }
  } else {
    activity = { available: false, note: 'Delivery verification is not yet recorded. Counts appear once deliveries are confirmed and simulated sends are marked.', delivered: 0, byWorker: [], windowDays: OUTCOME_WINDOW_DAYS }
  }

  // ---- verified outcomes: agency-confirmed fills, sent responses, corrected exceptions. Drafts, outreach and detection never count.
  const sh = await db.one<{ n: string }>("select count(*)::text as n from shifts where agency_id = $1 and status = 'filled' and filled_at >= $2", [agencyId, since])
  const rf = await db.one<{ n: string }>('select count(*)::text as n from referrals where agency_id = $1 and first_response_at is not null and first_response_at >= $2', [agencyId, since])
  const ex = await db.one<{ n: string }>("select count(*)::text as n from evv_exceptions where agency_id = $1 and status = 'corrected' and corrected_at >= $2", [agencyId, since])
  await db.auditRead('shifts', agencyId); await db.auditRead('referrals', agencyId); await db.auditRead('evv_exceptions', agencyId)
  const outcomes: VerifiedOutcomes = {
    windowDays: OUTCOME_WINDOW_DAYS, shiftsFilled: Number(sh?.n ?? 0), referralsAnswered: Number(rf?.n ?? 0), exceptionsCorrected: Number(ex?.n ?? 0),
    whatCounts: [
      'Shifts: only shifts the agency confirmed as filled in its scheduler. Offers sent to aides are not fills.',
      'Referrals: only referrals with a recorded first response. Drafted or proposed replies are not responses.',
      'EVV: only exceptions marked corrected. Detecting an exception is not a correction and not recovered payment.',
    ],
  }

  // ---- agency action items: needs-human list + proposed actions waiting for the agency's approval owner
  const pend = await db.one<{ n: string }>("select count(*)::text as n from proposed_actions where agency_id = $1 and status = 'proposed'", [agencyId])
  const pendingApprovals = Number(pend?.n ?? 0)
  const items = toActionItems(metrics, now)
  if (pendingApprovals > 0) items.push({ kind: 'approval', title: 'Proposed actions waiting for approval', detail: `${pendingApprovals} proposed action${pendingApprovals === 1 ? '' : 's'} wait for your approval owner. Nothing is sent until a person approves it.`, href: null, signal: { kind: 'approval', count: pendingApprovals } })
  const stalest = imports.filter(i => i.stale).sort((a, b) => (b.ageDays ?? 9e9) - (a.ageDays ?? 9e9))[0]
  if (stalest) items.push({ kind: 'freshness', title: 'Export and import fresh data', detail: stalest.ageDays === null ? `No ${stalest.kind} import has been committed yet.` : `${stalest.kind}: last import ${stalest.ageDays} days ago (stale after ${STALE_AFTER_DAYS}).`, href: '/app/evv', signal: { kind: 'freshness', staleDays: stalest.ageDays ?? 9999 } })
  else if (imports.length === 0) items.push({ kind: 'freshness', title: 'No data import recorded yet', detail: 'Export visits from your EVV vendor and send them to Deploi so exceptions can be checked.', href: '/app/evv', signal: { kind: 'freshness', staleDays: 9999 } })
  const actionItems = { items: rankActionItems(items), pendingApprovals }

  // ---- pilot progress (engage stream's table)
  let pilot: PilotProgress = { available: false, note: `Pilot records ${NOT_AVAILABLE}.`, startsOn: null, endsOn: null, metricKey: null, metricLabel: null, baseline: null, latest: null, decision: null, status: null }
  if (await tableExists(db, 'pilots')) {
    const p = await db.one<{ row: Record<string, unknown> }>('select to_jsonb(p) as row from pilots p where p.agency_id = $1 order by p.starts_on desc nulls last limit 1', [agencyId])
    if (p) {
      const row = p.row
      const metricKey = str(row, 'primary_metric_key')
      pilot = {
        available: true, note: null, startsOn: str(row, 'starts_on'), endsOn: str(row, 'ends_on'), metricKey,
        metricLabel: metricKey ? (metricLabelFor(metricKey) ?? metricKey) : null,
        baseline: firstNum(row, ['baseline_value', 'baseline', 'primary_metric_baseline', 'metric_baseline']),
        latest: firstNum(row, ['latest_value', 'latest', 'current_value', 'primary_metric_latest', 'metric_latest']),
        decision: str(row, 'decision'), status: str(row, 'status'),
      }
    } else {
      pilot = { ...pilot, available: true, note: 'No pilot recorded for your agency yet.' }
    }
  }

  // ---- relevant service limitations
  const defs = services.map(s => getService(s.key)).filter((s): s is ServiceDef => Boolean(s))
  const limitations = { rows: defs.map(s => ({ service: s.name, exclusions: s.exclusions, volumeLimits: s.volumeLimits })), csvNote: CSV_NOTE }

  return { services: { rows: services, note: servicesNote }, freshness, activity, outcomes, actionItems, pilot, limitations }
}

function firstNum(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) { const v = numOrNull(row, k); if (v !== null) return v }
  return null
}

function metricLabelFor(key: string): string | null {
  for (const s of (['referral_response', 'applicant_screening', 'retention_checkins', 'credential_tracking', 'open_shift_fill', 'authorization_watch', 'evv_exceptions', 'website_improvement'] as const)) {
    const m = getService(s)?.successMeasures.find(x => x.key === key)
    if (m) return m.label
  }
  return null
}

/** The needs-human list with the signals the urgency rules read, derived from the same metrics. */
export function toActionItems(m: Metrics, now = new Date()): ActionItem[] {
  return m.needsHuman.map(h => {
    switch (h.kind) {
      case 'exception': return { ...h, signal: { kind: 'exception', daysLeft: m.exceptions.openItems[0]?.daysLeft ?? null } }
      case 'shift': return { ...h, signal: { kind: 'shift', hoursUntil: m.shifts.nextOpenStartsAt ? Math.max(0, (new Date(m.shifts.nextOpenStartsAt).getTime() - now.getTime()) / 3600e3) : null } }
      case 'authorization': return { ...h, signal: { kind: 'authorization', pctLeft: m.authorizations.rows[0]?.pctLeft ?? null } }
      case 'referral': return { ...h, signal: { kind: 'referral', count: m.referrals.unanswered } }
    }
  })
}
